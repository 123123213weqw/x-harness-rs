import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from prepare_environment import run


class PreparedEnvironmentTests(unittest.TestCase):
    def exercise(self, changed):
        calls = []
        pip_calls = 0
        def command(argv, **kwargs):
            nonlocal pip_calls
            calls.append(argv)
            output = ''
            if 'pip' in argv:
                pip_calls += 1
                output = json.dumps([{'name': 'numpy', 'version': '2' if changed and pip_calls == 2 else '1'}])
            elif 'commit' in argv:
                output = 'sha256:' + 'a' * 64
            return SimpleNamespace(stdout=output, returncode=0)
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(task='build-cython-ext', output=Path(directory) / 'new')
            with patch('prepare_environment.DependencyProxy'), patch('prepare_environment.subprocess.run', side_effect=command):
                if changed:
                    with self.assertRaises(ValueError):
                        run(args)
                    self.assertFalse(any('commit' in call for call in calls))
                else:
                    run(args)
                    result = json.loads((args.output / 'manifest.json').read_text())
                    self.assertFalse(result['oracle_exposed'])
                    self.assertEqual(result['model_requests'], 0)
                    self.assertIn('@sha256:', result['base'])
                self.assertTrue(any(call[:3] == ['docker', 'rm', '-f'] for call in calls))
                self.assertFalse(any('cp' in call for call in calls))

    def test_clean_image_committed_only_after_unchanged_python_check(self):
        self.exercise(False)

    def test_python_change_refuses_image_commit(self):
        self.exercise(True)
