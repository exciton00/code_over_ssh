#!/usr/bin/env python3
"""cosh — Code Over SSH client (Python edition, zero-build fallback).

Wire-compatible with the C client (client/cosh.c): sends a file path to a
Code Over SSH extension host registered under $HOME/.code_over_ssh
(override with $COSH_STATE_DIR) and makes that user's VS Code window open
the file. Use it when compiling the C binary on the server is
inconvenient; behavior and exit codes are identical.
"""
import argparse
import base64
import json
import os
import socket
import sys

PATH_LIMIT = 4096
DEFAULT_TIMEOUT_SEC = 3


def load_hosts(state_dir):
    hosts = []
    hosts_dir = os.path.join(state_dir, "hosts")
    try:
        names = os.listdir(hosts_dir)
    except OSError:
        return hosts
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(hosts_dir, name), "r", encoding="utf-8") as f:
                info = json.load(f)
            if isinstance(info.get("socket"), str) and isinstance(info.get("heartbeat"), (int, float)):
                hosts.append(info)
        except (OSError, ValueError):
            continue
    hosts.sort(key=lambda h: h["heartbeat"], reverse=True)
    return hosts


def read_line(sock, timeout):
    buf = bytearray()
    while True:
        try:
            c = sock.recv(1)
        except socket.timeout:
            return None
        if not c:
            return None
        if c == b"\n":
            return buf.decode("utf-8", "replace")
        if len(buf) < 65536:
            buf += c


def try_host(host, token, file_path, timeout_sec):
    """Returns 1 success, 0 transport failure, -1 error (message printed)."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(timeout_sec)
        try:
            s.connect(host["socket"])
        except OSError as e:
            print("cosh: host %s: connect %s: %s" % (host["hostId"], host["socket"], e.strerror), file=sys.stderr)
            return 0
        s.sendall(("COSH/1 %s\n" % token).encode())
        line = read_line(s, timeout_sec)
        if line != "OK":
            print("cosh: host %s: %s" % (host["hostId"], line or "no reply"), file=sys.stderr)
            return -1
        s.sendall(b"OPEN " + base64.b64encode(file_path.encode()) + b"\n")
        line = read_line(s, timeout_sec)
        if line is None:
            print("cosh: host %s: no reply (timeout?)" % host["hostId"], file=sys.stderr)
            return 0
        if line.startswith("OK "):
            print("host %s: opened %s (%s)" % (host["hostId"], file_path, host.get("label", "")))
            return 1
        print("cosh: host %s: %s" % (host["hostId"], line), file=sys.stderr)
        return -1
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(
        prog="cosh",
        description="Open a file in your Code Over SSH VS Code window.",
    )
    ap.add_argument("path", nargs="?", help="file path to open")
    ap.add_argument("--list", action="store_true", help="list registered hosts and exit")
    ap.add_argument("--all", action="store_true", help="open in every registered window")
    ap.add_argument("--host", help="target one specific host id")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SEC, help="socket timeout seconds")
    ap.add_argument("--state-dir", help="override state directory")
    args = ap.parse_args()

    state_dir = args.state_dir or os.environ.get("COSH_STATE_DIR") or os.path.join(
        os.environ.get("HOME", ""), ".code_over_ssh"
    )

    try:
        with open(os.path.join(state_dir, "token"), "r", encoding="utf-8") as f:
            token = f.read().split()[0]
    except OSError:
        print(
            "cosh: no Code Over SSH state dir at %s\n"
            "Is a VS Code window connected to this machine via SSH as user %s?"
            % (state_dir, os.environ.get("USER", "(unknown)")),
            file=sys.stderr,
        )
        return 2

    hosts = load_hosts(state_dir)

    if args.list:
        if not hosts:
            print("no registered hosts under %s" % state_dir)
            return 2
        print("%-24s %-8s %12s  %s" % ("HOSTID", "PID", "HEARTBEAT", "LABEL"))
        for h in hosts:
            print("%-24s %-8s %12d  %s" % (h["hostId"], h.get("pid", 0), int(h["heartbeat"]), h.get("label", "")))
        return 0

    if not args.path:
        ap.error("path is required")

    # Only the client knows the shell's working directory: the extension host
    # would resolve a relative path against its own cwd (usually $HOME).
    file_path = os.path.abspath(args.path)
    if len(file_path) > PATH_LIMIT:
        print("cosh: path too long", file=sys.stderr)
        return 2

    if not hosts:
        print(
            "cosh: no registered hosts under %s\n"
            "Is a VS Code window connected to this machine via SSH as this user?" % state_dir,
            file=sys.stderr,
        )
        return 2

    succeeded = 0
    failed = 0
    for host in hosts:
        if args.host and host.get("hostId") != args.host:
            continue
        r = try_host(host, token, file_path, max(1, args.timeout))
        if r == 1:
            succeeded += 1
            if not args.all:
                break
        elif r == -1:
            failed += 1
        if args.host and r != 1:
            break
    if succeeded:
        return 0
    if failed:
        return 1
    print("cosh: could not reach any registered host", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
