"""Offline runner plumbing tests, NOT evidence of model quality."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == "linux", "fixture executable uses Linux shebang")
class RunnerTests(unittest.TestCase):
    def test_four_cases_and_no_credential_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "fixture"
            fixture.write_text('''#!/usr/bin/python3
import json, sys
from pathlib import Path
cfg=json.load(sys.stdin)
assert cfg['api_key']=='unit-test-placeholder'
root=Path(sys.argv[1]); case=sys.argv[2]
(root/'work').mkdir(parents=True)
base,cap,ceiling=(173,6,7301) if case=='recovery' else (137,7,9000)
(root/'work/retry.py').write_text(f'def retry_ms(attempt):\\n if attempt < 0: raise ValueError("negative")\\n return min({ceiling}, {base} * 2 ** min(attempt, {cap}))\\n')
(root/'metrics.json').write_text(json.dumps({'case':case,'model':cfg['model'],'usage':{'input_tokens':10,'output_tokens':2,'cache_read_tokens':5,'cache_write_tokens':0,'reasoning_tokens':3}}))
''')
            fixture.chmod(0o700)
            output = root / "report"
            command = [sys.executable, str(Path(__file__).with_name("history-live-ab.py")),
                       "--baseline", str(fixture), "--candidate", str(fixture),
                       "--output", str(output), "--baseline-revision", "test-before",
                       "--candidate-revision", "test-after"]
            result = subprocess.run(command, input=json.dumps({"api_key": "unit-test-placeholder", "model": "fixture"}),
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            rows = json.loads((output / "report.json").read_text())
            self.assertEqual(len(rows), 4)
            self.assertTrue(all(row["acceptance"]["ok"] for row in rows))
            self.assertTrue(all(row["total_input_tokens"] == 15 and row["total_output_tokens"] == 5 for row in rows))
            self.assertNotIn("unit-test-placeholder", result.stdout)
            for path in output.rglob("*"):
                if path.is_file():
                    self.assertNotIn("unit-test-placeholder", path.read_text())
            repeat = subprocess.run(command, input="{}", capture_output=True, text=True, timeout=5)
            self.assertNotEqual(repeat.returncode, 0)
            self.assertIn("must not already exist", repeat.stderr)


if __name__ == "__main__":
    unittest.main()
