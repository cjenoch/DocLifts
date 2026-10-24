import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def config(self, root):
        return {"image": "sha256:" + "a" * 64, "commit": "b" * 40, "network": "fictional_test",
                "socket_dir": str(root / "socket"), "limit": 25}

    def test_default_dry_run_and_apply_use_same_pinned_hardened_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.config(Path(temp))
            _, dry = worker.command(config)
            _, apply = worker.command(config, True)
            self.assertNotIn("--apply", dry)
            self.assertEqual(apply[-1], "--apply")
            self.assertIn("--read-only", dry)
            self.assertIn("1000:1000", dry)
            self.assertIn("/app/node_modules/tsx/dist/cli.mjs", dry)
            self.assertNotIn("pnpm", dry)
            self.assertIn("DELETION_LEDGER_SOCKET=" + worker.SOCKET_PATH, dry)
            self.assertNotIn("DELETION_LEDGER_PATH", " ".join(dry))
            with self.assertRaises(ValueError):
                worker.command({**config, "image": "untrusted:latest"})
            with self.assertRaises(ValueError):
                worker.command({**config, "limit": 0})

    def test_recovery_requires_offline_attestation_and_cannot_overwrite_ledger(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "newest.jsonl"
            path.write_text("{}\n")
            with self.assertRaises(ValueError):
                worker.command(self.config(root), recovery=str(path))
            _, args = worker.command(self.config(root), recovery=str(path), offline=True)
            self.assertIn("reconcile", args)
            self.assertIn("--ledger", args)
            self.assertTrue(any("privacy-recovery.jsonl,readonly" in arg for arg in args))
            self.assertNotIn("--apply", args)

    def test_worker_refuses_broad_production_env_or_public_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "worker.env"
            path.write_text("DATABASE_URL=fictional\nPHOTO_STORE=s3\nBETTER_AUTH_SECRET=not-needed\n")
            path.chmod(0o600)
            with self.assertRaises(ValueError):
                worker.read_env(path)
            path.write_text("DATABASE_URL=fictional\nPHOTO_STORE=s3\n")
            self.assertEqual(worker.read_env(path)["PHOTO_STORE"], "s3")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                worker.read_env(path)


if __name__ == "__main__":
    unittest.main()
