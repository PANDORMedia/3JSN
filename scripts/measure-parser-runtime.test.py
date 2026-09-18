"""Small harness checks only: these do not run a runtime benchmark."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location("measurement", Path(__file__).with_name("measure-parser-runtime.py"))
measurement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measurement)


class HarnessTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "darwin", "Darwin-only process measurement")
    def test_reaps_one_child_and_preserves_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = measurement.run_child([sys.executable, "-c", "print('child output')"], root / "stdout", root / "stderr", timeout=5)
            self.assertEqual((root / "stdout").read_text().strip(), "child output")
            self.assertGreater(result["parentLifecycleNanoseconds"], 0)
            self.assertGreater(result["peakResidentBytes"], 0)

    @unittest.skipUnless(sys.platform == "darwin", "Darwin-only process measurement")
    def test_timeout_kills_and_reaps_child(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            started = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, "timeout"):
                measurement.run_child([sys.executable, "-c", "import time; time.sleep(60)"], root / "stdout", root / "stderr", timeout=0.1)
            self.assertLess(time.monotonic() - started, 5)

    @unittest.skipIf(sys.platform == "darwin", "Non-Darwin rejection control")
    def test_unsupported_platform_rejects_before_opening_or_launching(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "Darwin only"):
                measurement.run_child(["must-not-be-launched"], root / "stdout", root / "stderr")
            self.assertEqual(list(root.iterdir()), [])

    def test_strict_record_count_variant_and_workload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stdout"
            record = {"layoutMeasurement": True, "dynamicHtml": False, "initializationNanoseconds": 7,
                      "initial": {"text": "snapshot"}, "verification": None, "gpuDeviceRequested": False}
            path.write_text(json.dumps({"compiledUi": {}}) + "\n" + json.dumps(record) + "\n")
            self.assertEqual(measurement.read_measurement(path, False), record)
            with self.assertRaisesRegex(ValueError, "variant"):
                measurement.read_measurement(path, True)
            path.write_text((json.dumps(record) + "\n") * 2)
            with self.assertRaisesRegex(ValueError, "exactly one"):
                measurement.read_measurement(path, False)
            record["gpuDeviceRequested"] = True
            path.write_text(json.dumps(record) + "\n")
            with self.assertRaisesRegex(ValueError, "GPU"):
                measurement.read_measurement(path, False)


if __name__ == "__main__":
    unittest.main()
