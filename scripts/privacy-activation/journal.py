#!/usr/bin/env python3
"""Private Unix-socket broker: acknowledge only verified encrypted off-host entries.

No installation or activation is performed by this file. Credentials are read
from the existing protected backup configuration, never from the web process.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import threading
import time

TAG = "doclifts-deletion-ledger-v1"
SNAPSHOT_HOST = "doclifts-deletion-ledger"
FILENAME = "/deletion.json"
MAX_BODY = 1024
TIMEOUT = 20
MAX_SNAPSHOTS = 100000


def validate_entry(value):
    if not isinstance(value, dict) or set(value) != {"version", "kind", "subjectHash", "requestedAt"}:
        raise ValueError("Invalid journal entry")
    if type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Invalid journal version")
    if value["kind"] not in ("account", "photo"):
        raise ValueError("Invalid journal kind")
    if not isinstance(value["subjectHash"], str) or not re.fullmatch("[a-f0-9]{64}", value["subjectHash"]):
        raise ValueError("Invalid subject hash")
    date = value["requestedAt"]
    if not isinstance(date, str) or not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z", date
    ):
        raise ValueError("Invalid request time")
    dt.datetime.fromisoformat(date.replace("Z", "+00:00"))
    return value


def encoded(entry):
    return (json.dumps(validate_entry(entry), sort_keys=True, separators=(",", ":")) + "\n").encode()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def exclusive_file(path, body):
    """Never overwrite restored evidence, follow a symlink, or leave a torn output."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(body)
            out.flush()
            os.fsync(out.fileno())
        sync_directory(path.parent)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def read_env(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not re.fullmatch("[A-Z_][A-Z0-9_]*", key.strip()):
            raise ValueError("Invalid protected environment file")
        values[key.strip()] = value.strip().strip("\"'")
    return values


class Restic:
    def __init__(self, backup_config):
        config = json.loads(Path(backup_config).read_text())
        self.env = os.environ.copy()
        self.env.update(read_env(config["env_file"]))
        self.env.update(
            RESTIC_REPOSITORY=config["repository"],
            RESTIC_PASSWORD_FILE=config["password_file"],
            RESTIC_CACHE_DIR=config["cache_dir"],
        )

    def run(self, args, body=None, deadline=None):
        remaining = (deadline - time.monotonic()) if deadline else TIMEOUT
        if remaining <= 0:
            raise TimeoutError("Journal deadline elapsed")
        result = subprocess.run(
            ["/usr/bin/restic", "--retry-lock", "1s", *args],
            input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=self.env, timeout=remaining, check=False,
        )
        # Suppress raw stderr: it can contain endpoints, credentials and private paths.
        if result.returncode:
            raise RuntimeError("Encrypted journal operation failed")
        if len(result.stdout) > 32 * 1024 * 1024:
            raise RuntimeError("Journal response exceeded bound")
        return result.stdout

    def snapshots(self, extra_tag=None, deadline=None):
        tags = TAG + ("," + extra_tag if extra_tag else "")
        rows = json.loads(self.run(["snapshots", "--json", "--tag", tags], deadline=deadline))
        if not isinstance(rows, list) or len(rows) > MAX_SNAPSHOTS:
            raise ValueError("Journal inventory exceeds recovery bound")
        for row in rows:
            if (
                not re.fullmatch("[a-f0-9]{64}", row.get("id", ""))
                or TAG not in row.get("tags", [])
                or "complete" in row.get("tags", [])
                or (extra_tag and extra_tag not in row.get("tags", []))
            ):
                raise ValueError("Unexpected journal snapshot")
        return rows

    def dump(self, snapshot, deadline=None):
        body = self.run(["dump", snapshot, FILENAME], deadline=deadline)
        if len(body) > MAX_BODY:
            raise ValueError("Journal entry exceeded bound")
        return validate_entry(json.loads(body))

    def persist(self, entry, deadline):
        body = encoded(entry)
        entry_tag = "entry-" + hashlib.sha256(body).hexdigest()
        rows = self.snapshots(entry_tag, deadline)
        if rows:
            # A cache or restored host file is never proof of current off-host durability.
            snapshot = rows[0]["id"]
        else:
            output = self.run(
                ["backup", "--json", "--stdin", "--stdin-filename", FILENAME.lstrip("/"),
                 "--host", SNAPSHOT_HOST, "--tag", TAG, "--tag", entry_tag],
                body, deadline,
            )
            summaries = [json.loads(line) for line in output.splitlines() if line.strip()]
            ids = [row.get("snapshot_id") for row in summaries if row.get("message_type") == "summary"]
            if len(ids) != 1 or not re.fullmatch("[a-f0-9]{64}", ids[0] or ""):
                raise ValueError("Journal snapshot identity unavailable")
            snapshot = ids[0]
        if self.dump(snapshot, deadline) != entry:
            raise ValueError("Encrypted journal verification failed")
        return snapshot

    def recover(self):
        # Union all dedicated snapshots, not "latest", host time or a restored cache.
        records = {}
        for row in self.snapshots():
            entry = self.dump(row["id"])
            key = (entry["kind"], entry["subjectHash"])
            old = records.get(key)
            if old is None or entry["requestedAt"] < old["requestedAt"]:
                records[key] = entry
        return sorted(records.values(), key=lambda e: (e["requestedAt"], e["kind"], e["subjectHash"]))


class Journal:
    def __init__(self, restic, state):
        self.restic = restic
        self.state = Path(state)
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.entries = self.state / "entries"
        self.entries.mkdir(mode=0o700, exist_ok=True)
        self.busy = threading.Lock()

    def append(self, entry):
        body = encoded(entry)
        if not self.busy.acquire(blocking=False):
            raise BlockingIOError("Journal busy")
        try:
            path = self.entries / (hashlib.sha256(body).hexdigest() + ".json")
            if path.exists():
                if path.is_symlink() or path.read_bytes() != body:
                    raise ValueError("Local journal integrity failure")
            else:
                exclusive_file(path, body)
            snapshot = self.restic.persist(entry, time.monotonic() + TIMEOUT)
            return {"durable": True, "entry": entry, "snapshot": snapshot}
        finally:
            self.busy.release()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *_args):
        pass

    def setup(self):
        self.request.settimeout(2)
        super().setup()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if (
                self.path != "/append" or not 0 < length <= MAX_BODY
                or self.headers.get("Content-Type") != "application/json"
                or self.headers.get("Transfer-Encoding")
            ):
                raise ValueError("Invalid request")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request")
            result = self.server.journal.append(validate_entry(json.loads(raw)))
            status = 200
        except (ValueError, json.JSONDecodeError):
            status, result = 400, {"error": "Invalid journal request"}
        except Exception:
            status, result = 503, {"error": "Journal durability unavailable; retry"}
        payload = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, path, journal, allowed_uid):
        self.journal = journal
        self.allowed_uid = allowed_uid
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(path, Handler)

    def verify_request(self, request, _address):
        _pid, uid, _gid = struct.unpack("3i", request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return uid in (0, self.allowed_uid)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, _request, _address):
        # Request bodies, identifiers and paths never go to journalctl.
        print("Privacy journal connection failed", file=sys.stderr)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["serve", "recover"])
    parser.add_argument("--backup-config", required=True)
    parser.add_argument("--state-dir")
    parser.add_argument("--socket")
    parser.add_argument("--allowed-uid", type=int)
    parser.add_argument("--socket-gid", type=int)
    parser.add_argument("--output")
    args = parser.parse_args()
    try:
        restic = Restic(args.backup_config)
        if args.mode == "recover":
            if not args.output or not Path(args.output).is_absolute():
                raise ValueError("A new absolute recovery output path is required")
            records = restic.recover()
            exclusive_file(Path(args.output), b"".join(encoded(e) for e in records))
            print(json.dumps({"recovered": len(records)}))
            return 0
        if not all((args.state_dir, args.socket)) or args.allowed_uid is None or args.socket_gid is None:
            raise ValueError("Broker state, socket and permitted identity are required")
        state, path = Path(args.state_dir), Path(args.socket)
        if not state.is_absolute() or not path.is_absolute():
            raise ValueError("Broker paths must be absolute")
        journal = Journal(restic, state)
        # Process lifetime lock prevents unlinking a live broker socket on double start.
        with (state / "broker.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if path.exists() or path.is_symlink():
                if path.is_symlink() or not stat.S_ISSOCK(path.lstat().st_mode):
                    raise ValueError("Refusing to replace non-socket path")
                path.unlink()
            with Server(str(path), journal, args.allowed_uid) as server:
                os.chmod(path, 0o660)
                os.chown(path, -1, args.socket_gid)
                server.serve_forever()
    except Exception:
        print("Privacy journal operation failed; verify protected configuration", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
