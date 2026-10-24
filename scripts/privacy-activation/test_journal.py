import copy
import http.client
import socket
import threading
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location("journal", Path(__file__).with_name("journal.py"))
journal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal)


def entry(kind="account", value="a"):
    return {"version": 1, "kind": kind, "subjectHash": value * 64,
            "requestedAt": "2026-01-01T00:00:00.000Z"}


class FakeRestic:
    def __init__(self):
        self.records = []
        self.fail = False

    def persist(self, record, deadline):
        if self.fail:
            raise RuntimeError("synthetic provider outage")
        self.records.append(copy.deepcopy(record))
        return "a" * 64


class JournalTests(unittest.TestCase):
    def test_unix_socket_protocol_checks_private_peer_and_reports_durability(self):
        with tempfile.TemporaryDirectory() as temp:
            path = str(Path(temp) / "journal.sock")
            remote = FakeRestic()
            broker = journal.Journal(remote, Path(temp) / "state")
            with journal.Server(path, broker, os.getuid()) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                def request(body):
                    connection = http.client.HTTPConnection("localhost", timeout=3)
                    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    connection.sock.settimeout(3)
                    connection.sock.connect(path)
                    connection.request("POST", "/append", body=json.dumps(body),
                                       headers={"Content-Type": "application/json"})
                    response = connection.getresponse()
                    result = response.status, json.loads(response.read())
                    connection.close()
                    return result
                try:
                    status, result = request(entry())
                    self.assertEqual(status, 200)
                    self.assertTrue(result["durable"])
                    remote.fail = True
                    status, result = request(entry("photo", "c"))
                    self.assertEqual(status, 503)
                    self.assertNotIn("durable", result)
                    self.assertEqual(request({**entry(), "rawId": "forbidden"})[0], 400)
                finally:
                    server.shutdown()
                    thread.join()

    def test_ack_requires_remote_success_and_failure_keeps_local_intent(self):
        with tempfile.TemporaryDirectory() as temp:
            remote = FakeRestic()
            broker = journal.Journal(remote, temp)
            remote.fail = True
            with self.assertRaises(RuntimeError):
                broker.append(entry())
            self.assertEqual(len(list((Path(temp) / "entries").glob("*.json"))), 1)
            self.assertEqual(remote.records, [])
            remote.fail = False
            result = broker.append(entry())
            self.assertTrue(result["durable"])
            self.assertEqual(remote.records, [entry()])

    def test_busy_request_cannot_ack_or_write_another_entry(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = journal.Journal(FakeRestic(), temp)
            broker.busy.acquire()
            try:
                with self.assertRaises(BlockingIOError):
                    broker.append(entry())
                self.assertEqual(list((Path(temp) / "entries").iterdir()), [])
            finally:
                broker.busy.release()

    def test_rejects_identifiers_extra_fields_and_invalid_date(self):
        for value in [
            {**entry(), "email": "fictional@test.local"},
            {**entry(), "subjectHash": "raw-owner-id"},
            {**entry(), "version": True},
            {**entry(), "requestedAt": "2026-02-31T00:00:00Z"},
            {**entry(), "requestedAt": "2026-01-01T00:00:00+02:00"},
        ]:
            with self.assertRaises(ValueError):
                journal.validate_entry(value)

    def test_durable_proof_requires_dump_to_match_not_just_successful_backup(self):
        remote = object.__new__(journal.Restic)
        remote.snapshots = lambda *_: [{"id": "a" * 64}]
        remote.dump = lambda *_: entry(value="b")
        with self.assertRaisesRegex(ValueError, "verification"):
            remote.persist(entry(), time.monotonic() + 20)

    def test_recovery_unions_all_snapshots_and_refuses_partial_or_wrong_tag_evidence(self):
        remote = object.__new__(journal.Restic)
        remote.snapshots = lambda: [{"id": "old"}, {"id": "new"}, {"id": "repeat"}]
        remote.dump = lambda snapshot: entry("photo", "b") if snapshot == "new" else entry()
        self.assertEqual(len(remote.recover()), 2)
        remote.dump = lambda _: (_ for _ in ()).throw(ValueError("partial"))
        with self.assertRaises(ValueError):
            remote.recover()
        remote = object.__new__(journal.Restic)
        remote.run = lambda *_args, **_kwargs: json.dumps(
            [{"id": "a" * 64, "tags": [journal.TAG, "complete"]}]
        ).encode()
        with self.assertRaises(ValueError):
            remote.snapshots()

    def test_recovery_never_overwrites_existing_output_or_follows_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "recovery.jsonl"
            journal.exclusive_file(target, b"original\n")
            with self.assertRaises(FileExistsError):
                journal.exclusive_file(target, b"replacement\n")
            link = Path(temp) / "link"
            link.symlink_to(target)
            with self.assertRaises(FileExistsError):
                journal.exclusive_file(link, b"replacement\n")
            self.assertEqual(target.read_bytes(), b"original\n")


@unittest.skipUnless(os.environ.get("DOCLIFTS_TEST_RESTIC") == "1" and shutil.which("restic"),
                     "explicit disposable local-restic rehearsal only")
class RealResticTests(unittest.TestCase):
    def test_offhost_union_survives_old_host_state_and_normal_prune(self):
        # Local disposable repository only. No production env/config/storage is loaded.
        with tempfile.TemporaryDirectory(prefix="privacy-restic-test-") as temp:
            root = Path(temp)
            password = root / "password"
            password.write_text("fictional-recovery-password-only\n")
            password.chmod(0o600)
            env_file = root / "empty.env"
            env_file.write_text("")
            config = root / "config.json"
            config.write_text(json.dumps({
                "env_file": str(env_file), "repository": str(root / "repository"),
                "password_file": str(password), "cache_dir": str(root / "cache"),
            }))
            remote = journal.Restic(config)
            # Clear inherited provider/config variables: this test can only address local paths.
            remote.env = {"PATH": os.environ["PATH"],
                          "RESTIC_REPOSITORY": str(root / "repository"),
                          "RESTIC_PASSWORD_FILE": str(password),
                          "RESTIC_CACHE_DIR": str(root / "cache")}
            remote.run(["init"])
            old_host = journal.Journal(remote, root / "old-host")
            first = old_host.append(entry())
            new_host = journal.Journal(remote, root / "new-host")
            new_host.append(entry("photo", "b"))
            # Replaying an old host never replaces newer journal records.
            self.assertEqual(old_host.append(entry())["snapshot"], first["snapshot"])
            self.assertEqual(len(remote.snapshots()), 2)
            for index in range(4):
                remote.run(["backup", "--stdin", "--stdin-filename", "ordinary.txt",
                            "--host", "fictional-vps", "--tag", "complete"],
                           ("normal backup " + str(index)).encode())
            remote.run(["forget", "--host", "fictional-vps", "--tag", "complete",
                        "--group-by", "host,paths", "--keep-last", "3", "--prune"])
            self.assertEqual(remote.recover(), [entry(), entry("photo", "b")])
            # A new recovery process, with no old local journal, finds the same union.
            recovered = root / "recovered.jsonl"
            journal.exclusive_file(recovered, b"".join(journal.encoded(e) for e in remote.recover()))
            self.assertEqual(len(recovered.read_text().splitlines()), 2)
            self.assertNotIn("complete", remote.snapshots()[0]["tags"])


if __name__ == "__main__":
    unittest.main()
