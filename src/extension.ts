/**
 * Code Over SSH — VS Code extension entry point.
 *
 * Runs in the *workspace* extension host: on a Remote-SSH window that is the
 * host on the remote server (the one reached by SSH), where the `cosh`
 * client binary talks to it over a Unix socket. Files requested over the
 * socket are opened in the (local) editor through the normal
 * openTextDocument/showTextDocument APIs, which VS Code relays over the
 * existing SSH tunnel — no extra listening ports involved.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CoshServer, startCoshServer } from './server';

let server: CoshServer | undefined;
let output: vscode.OutputChannel;

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('code_over_ssh');
}

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/**
 * Validate a requested path. Returns null when the path may be opened,
 * otherwise an error message.
 */
function validatePath(rawPath: string): string | null {
  let filePath: string;
  try {
    filePath = fs.realpathSync(rawPath);
  } catch {
    return `file does not exist: ${rawPath}`;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return `file does not exist: ${rawPath}`;
  }
  if (!st.isFile()) {
    return `not a regular file: ${filePath}`;
  }
  if (config().get<boolean>('restrictToWorkspace', false)) {
    const roots = workspaceRoots();
    const inside = roots.some((root) => {
      let realRoot: string;
      try {
        realRoot = fs.realpathSync(root);
      } catch {
        realRoot = root;
      }
      const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      return filePath === realRoot || filePath.startsWith(prefix);
    });
    if (!inside) {
      return `path is outside the workspace folders (code_over_ssh.restrictToWorkspace is on)`;
    }
  }
  return null;
}

async function openFile(rawPath: string): Promise<string | void> {
  const err = validatePath(rawPath);
  if (err) {
    throw new Error(err);
  }
  const filePath = fs.realpathSync(rawPath);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
  if (config().get<boolean>('notifyOnOpen', true)) {
    vscode.window.showInformationMessage(
      `Code Over SSH: opened ${path.basename(filePath)} (from cosh client)`,
    );
  }
  return `opened in editor`;
}

async function start(): Promise<void> {
  if (server) {
    return;
  }
  const stateDir = config().get<string>('stateDir', '') || undefined;
  const label =
    `${vscode.env.appName} | ${vscode.workspace.name ?? '(no folder)'} | ${vscode.env.remoteName ?? 'local'}`;
  try {
    server = await startCoshServer({
      stateDir,
      label,
      onOpen: openFile,
      log: (msg) => output.appendLine(msg),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(`failed to start: ${msg}`);
    vscode.window.showErrorMessage(`Code Over SSH: failed to start: ${msg}`);
    return;
  }
  output.appendLine(`hostId=${server.hostId} socket=${server.socketPath}`);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Code Over SSH');
  context.subscriptions.push(output);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = 'Code Over SSH';
  status.command = 'code_over_ssh.showLog';
  context.subscriptions.push(status);

  const refreshStatus = () => {
    if (server) {
      status.text = '$(broadcast) cosh';
      status.tooltip = `Code Over SSH\nsocket: ${server.socketPath}\n\nClient: cosh <path>`;
      status.show();
    } else {
      status.hide();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('code_over_ssh.showLog', () => {
      output.show();
    }),
    vscode.commands.registerCommand('code_over_ssh.openPath', async () => {
      const p = await vscode.window.showInputBox({
        prompt: 'File path to open (on this machine)',
        placeHolder: '/abs/path/to/file',
      });
      if (!p) {
        return;
      }
      try {
        await openFile(p);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Code Over SSH: ${msg}`);
      }
    }),
  );

  // (Re)start the server whenever workspace config changes (stateDir) or the
  // window becomes ready. Keep it simple: start once, and restart on
  // configuration changes that affect startup.
  void start().then(refreshStatus);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('code_over_ssh.stateDir')) {
        void (async () => {
          if (server) {
            await server.stop();
            server = undefined;
          }
          await start();
          refreshStatus();
        })();
      }
    }),
  );

  // Stop the server when the extension is deactivated (window closed / server
  // shutdown). The registry entry is removed so the client won't try a dead
  // socket.
  context.subscriptions.push({
    dispose: async () => {
      if (server) {
        await server.stop();
        server = undefined;
      }
    },
  });
}

export function deactivate(): void {
  // subscriptions' dispose handles cleanup.
}
