"""Regressions for measurement validity, separate from application acceptance."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("profile_memory", Path(__file__).with_name("profile-memory.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class MeasurementTests(unittest.TestCase):
    def test_native_self_read_has_process_identity_and_real_memory(self):
        result = mod.Sampler().sample(os.getpid())
        self.assertTrue(result["identity"])
        self.assertGreater(result["rss_bytes"], 0)

    def test_failed_process_never_becomes_zero_in_total(self):
        self.assertIsNone(mod.totals([{"error": "exited"}])["rss_bytes"])

    def test_duplicate_role_pid_is_rejected(self):
        with self.assertRaises(ValueError):
            mod.validate_manifest({"phase": "idle", "scope": "partial", "coverage_note": "fixture", "processes": [{"role": "shell", "pid": 1}, {"role": "frontend", "pid": 1}]})

    def test_truncated_and_short_logs_are_rejected(self):
        metadata = {"type": "metadata", "duration_seconds": 10}
        sample = {"type": "sample", "phase": "idle", "sample_duration_seconds": .01, "processes": [], "groups": {}}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "log.jsonl"
            for rows in [[metadata], [metadata, sample], [metadata, sample, {"type": "end", "elapsed_seconds": 3}]]:
                path.write_text("\n".join(map(json.dumps, rows)))
                with self.assertRaises(ValueError): mod.summarize(path)
            path.write_text("\n".join(map(json.dumps, [metadata, sample, {"type": "end", "elapsed_seconds": 10}])))
            self.assertEqual(mod.summarize(path)["sample_errors"], 0)

if __name__ == "__main__": unittest.main()
