#!/usr/bin/env python3
"""Run a reviewed builder image by immutable local image ID. Dry-run by default."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

ENV_KEYS = {
    "DATABASE_URL", "PHOTO_STORE", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET",
    "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
}
SOCKET_PATH = "/run/doclifts-privacy-journal/journal.sock"


def read_env(path):
    source = Path(path)
    if source.is_symlink() or source.stat().st_mode & 0o077:
        raise ValueError("Worker environment must be a private regular file")
    values = {}
    for line in source.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or key.strip() not in ENV_KEYS:
            raise ValueError("Unexpected worker environment key")
        values[key.strip()] = value.strip().strip("\"'")
    if not values.get("DATABASE_URL") or values.get("PHOTO_STORE") != "s3":
        raise ValueError("Explicit database and S3 configuration required")
    return values


def command(config, apply=False, recovery=None, offline=False):
    image, commit = config["image"], config["commit"]
    if not re.fullmatch("sha256:[a-f0-9]{64}", image):
        raise ValueError("Pin the immutable local image ID, not a tag")
    if not re.fullmatch("[a-f0-9]{40}", commit):
        raise ValueError("Pin the reviewed commit")
    if not re.fullmatch("[a-zA-Z0-9_.-]+", config["network"]):
        raise ValueError("Invalid isolated network")
    socket_dir = Path(config["socket_dir"])
    if not socket_dir.is_absolute() or socket_dir.is_symlink():
        raise ValueError("Explicit broker directory required")
    limit = config.get("limit", 25)
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("Limit must be 1..100")
    if recovery and (not offline or not Path(recovery).is_absolute()):
        raise ValueError("Recovery requires an absolute ledger and offline attestation")
    name = "doclifts-privacy-worker-" + uuid.uuid4().hex
    args = [
        "docker", "run", "--rm", "--name", name, "--pull", "never",
        "--user", "1000:1000", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--pids-limit", "128",
        "--memory", "512m", "--cpus", "0.5", "--network", config["network"],
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
        "--mount", "type=bind,src=" + str(socket_dir) + ",dst=/run/doclifts-privacy-journal,readonly",
        "--env", "DELETION_LEDGER_SOCKET=" + SOCKET_PATH,
    ]
    if "," in str(socket_dir):
        raise ValueError("Unsupported mount path")
    for key in sorted(ENV_KEYS):
        args.extend(["--env", key])
    if recovery:
        path = Path(recovery)
        if path.is_symlink() or not path.is_file() or "," in str(path):
            raise ValueError("Recovery ledger must be a regular file")
        args.extend(["--mount", "type=bind,src=" + str(path) + ",dst=/run/privacy-recovery.jsonl,readonly"])
    args.extend([
        image, "node", "/app/node_modules/tsx/dist/cli.mjs", "/app/scripts/privacy.ts",
        "--mode", "reconcile" if recovery else "deletions", "--all", "--limit", str(limit),
    ])
    if recovery:
        args.extend(["--ledger", "/run/privacy-recovery.jsonl"])
    if apply:
        args.append("--apply")
    return name, args


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--recover-ledger")
    parser.add_argument("--offline-confirmed", action="store_true")
    args = parser.parse_args()
    name = None
    started = False
    try:
        config = json.loads(Path(args.config).read_text())
        name, run = command(config, args.apply, args.recover_ledger, args.offline_confirmed)
        image = subprocess.run(
            ["docker", "image", "inspect", config["image"], "--format", "{{json .Config.Env}}"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=10,
        )
        expected = "DOCLIFTS_BUILD_SHA=" + config["commit"]
        if expected not in json.loads(image.stdout):
            raise ValueError("Image does not identify the reviewed source commit")
        # Only explicitly enumerated values enter the worker container.
        env = os.environ.copy()
        values = read_env(config["env_file"])
        env.update(values)
        for key in ENV_KEYS - set(values):
            env.pop(key, None)
        started = True
        result = subprocess.run(run, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900)
        if result.returncode or len(result.stdout) > 8192:
            raise RuntimeError("Worker failed; inspect job state and retry")
        print(json.dumps(json.loads(result.stdout)))
        return 0
    except Exception:
        # Docker/driver errors can contain private values. Never relay raw stderr.
        print("Privacy worker failed; verify pinned runtime and protected configuration", file=sys.stderr)
        return 1
    finally:
        if name and started:
            # Only the generated container from this invocation; never stop a shared service.
            subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=20)


if __name__ == "__main__":
    sys.exit(main())
