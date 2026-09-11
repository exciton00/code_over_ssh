/**
 * Code Over SSH — protocol server (pure Node, no VS Code dependency).
 *
 * A small line-based protocol over a per-host Unix domain socket:
 *
 *   C->S: COSH/1 <token>\n
 *   S->C: OK\n
 *   C->S: OPEN <base64(path)>\n
 *   S->C: OK <base64(abspath)>\n     or      ERR <message>\n
 *
 * One OPEN per connection; the server closes the socket after replying.
 *
 * Multi-user isolation: the state dir defaults to $HOME/.code_over_ssh and
 * is created 0700 (socket 0600), so on a shared server each Unix user can
 * only ever see and talk to their own hosts.
 *
 * Multi-window (same user): every extension host gets its own socket and a
 * registry entry with a heartbeat; the client picks the freshest one.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export interface CosshHostInfo {
  pid: number;
  hostId: string;
  socket: string;
  heartbeat: number;
  label: string;
}

export interface CoshServerOptions {
  /** Defaults to $HOME/.code_over_ssh */
  stateDir?: string;
  /** Human readable description stored in the registry (e.g. window title) */
  label?: string;
  /** Registry refresh interval, default 5000 ms */
  heartbeatMs?: number;
  /** Called when a validated OPEN request arrives. Return a short message for the log. */
  onOpen: (filePath: string) => Promise<string | void> | string | void;
  /** Log sink; defaults to console */
  log?: (msg: string) => void;
}

export interface CoshServer {
  stateDir: string;
  hostId: string;
  socketPath: string;
  registryPath: string;
  token: string;
  stop(): Promise<void>;
}

const PROTO = 'COSH/1';
const DEFAULT_HEARTBEAT_MS = 5000;
/** Registry entries with no heartbeat for this long are considered stale. */
const STALE_MS = 30000;
const MAX_LINE = 64 * 1024;

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function defaultStateDir(): string {
  return path.join(os.homedir(), '.code_over_ssh');
}

export function ensureStateDir(stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(stateDir, 'hosts'), { recursive: true, mode: 0o700 });
  // mkdir modes are subject to umask; enforce the intended permissions.
  try {
    fs.chmodSync(stateDir, 0o700);
    fs.chmodSync(path.join(stateDir, 'hosts'), 0o700);
  } catch {
    /* best effort */
  }
}

export function readOrCreateToken(stateDir: string): string {
  const tokenPath = path.join(stateDir, 'token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(existing)) {
      return existing;
    }
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  return token;
}

function writeRegistry(registryPath: string, info: CosshHostInfo): void {
  const tmp = registryPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, registryPath);
}

/** Remove registry entries that are stale (no recent heartbeat / dead pid). */
export function cleanStaleHosts(stateDir: string, log?: (msg: string) => void): void {
  const hostsDir = path.join(stateDir, 'hosts');
  let entries: string[];
  try {
    entries = fs.readdirSync(hostsDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const file = path.join(hostsDir, name);
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8')) as CosshHostInfo;
      if (typeof info.heartbeat !== 'number' || now - info.heartbeat < STALE_MS) {
        continue;
      }
      // Double check the owning process is really gone (pid reuse is possible
      // but harmless here: worst case we delete a registry a live host will
      // re-write on its next heartbeat).
      let alive = true;
      try {
        process.kill(info.pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        fs.unlinkSync(file);
        log?.(`cleaned stale registry ${name}`);
      }
    } catch {
      /* unreadable/broken entry: leave it, a live host may fix or GC later */
    }
  }
}

/**
 * Enumerate registered hosts for a state dir (used by the C client via
 * `cosh --list` semantics, and by tests). Exposed here so behavior stays in
 * one place.
 */
export function listHosts(stateDir: string): CosshHostInfo[] {
  const hostsDir = path.join(stateDir, 'hosts');
  let entries: string[];
  try {
    entries = fs.readdirSync(hostsDir);
  } catch {
    return [];
  }
  const out: CosshHostInfo[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) {
      continue;
    }
    try {
      const info = JSON.parse(fs.readFileSync(path.join(hostsDir, name), 'utf8')) as CosshHostInfo;
      if (typeof info.socket === 'string' && typeof info.heartbeat === 'number') {
        out.push(info);
      }
    } catch {
      /* ignore broken entry */
    }
  }
  out.sort((a, b) => b.heartbeat - a.heartbeat);
  return out;
}

export async function startCoshServer(opts: CoshServerOptions): Promise<CoshServer> {
  const log = opts.log ?? ((msg: string) => console.log(`[cosh] ${msg}`));
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  const stateDir = opts.stateDir ?? defaultStateDir();
  ensureStateDir(stateDir);
  const token = readOrCreateToken(stateDir);
  cleanStaleHosts(stateDir, log);

  const hostId = `${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
  const socketPath = path.join(stateDir, `sock-${hostId}`);
  const registryPath = path.join(stateDir, 'hosts', `${hostId}.json`);

  // Remove our own socket file if a previous process of ours left one behind.
  try {
    fs.unlinkSync(socketPath);
  } catch {
    /* did not exist */
  }

  const info: CosshHostInfo = {
    pid: process.pid,
    hostId,
    socket: socketPath,
    heartbeat: Date.now(),
    label: opts.label ?? `window ${process.pid}`,
  };
  writeRegistry(registryPath, info);

  const server = net.createServer();
  const activeSockets = new Set<net.Socket>();

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
    socket.on('error', () => {
      /* peer vanished; ignore */
    });
    socket.setTimeout(10_000, () => socket.destroy());

    let buffer = '';
    let phase: 'auth' | 'request' | 'done' = 'auth';

    const reply = (line: string) => {
      try {
        socket.write(line + '\n');
      } catch {
        /* ignore */
      }
    };

    // A request is activity: refresh the heartbeat so "freshest host"
    // tracks the most recently used window.
    const touch = () => {
      info.heartbeat = Date.now();
      try {
        writeRegistry(registryPath, info);
      } catch {
        /* best effort */
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_LINE) {
        reply('ERR line too long');
        phase = 'done';
        socket.end();
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (phase === 'done') {
          continue;
        }
        if (phase === 'auth') {
          phase = 'request';
          const m = /^COSH\/1 (\S+)$/.exec(line.trim());
          if (!m || !timingSafeEqual(m[1], token)) {
            reply('ERR bad handshake');
            phase = 'done';
            socket.end();
            return;
          }
          reply('OK');
          continue;
        }
        // request phase: expect exactly one OPEN line
        phase = 'done';
        handleRequest(socket, line, reply);
        return;
      }
    });

    async function handleRequest(
      socket: net.Socket,
      line: string,
      reply: (line: string) => void,
    ): Promise<void> {
      const m = /^OPEN (\S+)$/.exec(line.trim());
      if (!m) {
        reply('ERR expected OPEN <base64path>');
        socket.end();
        return;
      }
      let filePath: string;
      try {
        filePath = Buffer.from(m[1], 'base64').toString('utf8');
      } catch {
        reply('ERR bad base64');
        socket.end();
        return;
      }
      if (filePath.length === 0 || filePath.length > 4096) {
        reply('ERR bad path');
        socket.end();
        return;
      }
      touch();
      try {
        const result = await opts.onOpen(filePath);
        reply(`OK ${Buffer.from(path.resolve(filePath), 'utf8').toString('base64')}`);
        log(`open: ${filePath}${typeof result === 'string' ? ' -> ' + result : ''}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply(`ERR ${msg.replace(/\s+/g, ' ').slice(0, 200)}`);
        log(`open failed: ${filePath} -> ${msg}`);
      }
      socket.end();
    }

    socket.on('error', (err: Error) => log(`socket error: ${err.message}`));
  });

  const heartbeat = setInterval(() => {
    info.heartbeat = Date.now();
    try {
      writeRegistry(registryPath, info);
    } catch (err) {
      log(`heartbeat write failed: ${String(err)}`);
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      // Tighten permissions now that the socket exists.
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        /* best effort */
      }
      resolve();
    });
  });
  log(`listening on ${socketPath} (hostId=${hostId})`);

  return {
    stateDir,
    hostId,
    socketPath,
    registryPath,
    token,
    async stop() {
      clearInterval(heartbeat);
      for (const s of activeSockets) {
        s.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const f of [socketPath, registryPath]) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* already gone */
        }
      }
      log(`stopped (hostId=${hostId})`);
    },
  };
}
