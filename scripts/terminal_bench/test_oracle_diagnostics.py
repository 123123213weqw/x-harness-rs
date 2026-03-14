import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from preflight_oracle import run


class OracleDiagnosticTests(unittest.TestCase):
    def exercise(self, diagnostic_error):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'result'
            args = SimpleNamespace(tasks=root, task='build-cython-ext', output=output,
                diagnose_cython_repository=True, source_bundle=None, oracle_seconds=600,
                wheelhouse=root, offline_wheels=True, prepared_image='sha256:fixture',
                verifier_showlocals=False)
            commands = []

            def command(argv, **kwargs):
                commands.append(argv)
                if any(':/logs/verifier/.' in item for item in argv):
                    (output / 'reward.txt').write_text('0')
                    (output / 'ctrf.json').write_text('{}')
                if any('diagnostic_dir=' in item for item in argv):
                    if diagnostic_error:
                        raise subprocess.TimeoutExpired(argv, 60)
                    return SimpleNamespace(returncode=0)
                return SimpleNamespace(returncode=0)

            grade = dict(status='FAIL', executed=11, failed=1)
            with patch('preflight_oracle.DependencyProxy'), patch('preflight_oracle.print'), \
                    patch('preflight_oracle.grade_evidence', return_value=grade), \
                    patch('preflight_oracle.subprocess.run', side_effect=command):
                self.assertEqual(run(args), 1)
            result = json.loads((output / 'preflight-result.json').read_text())
            self.assertEqual(result['status'], 'FAIL')
            self.assertEqual(result['failed'], 1)
            self.assertEqual(result['repository_diagnostic_exit'],
                             'TimeoutExpired' if diagnostic_error else 0)
            copy_index = next(i for i, cmd in enumerate(commands)
                              if any(':/logs/verifier/.' in item for item in cmd))
            diagnostic_index = next(i for i, cmd in enumerate(commands)
                                    if any('diagnostic_dir=' in item for item in cmd))
            self.assertLess(copy_index, diagnostic_index)
            self.assertEqual(commands[-1][:3], ['docker', 'rm', '-f'])

    def test_diagnostic_success_does_not_replace_official_failure(self):
        self.exercise(False)

    def test_diagnostic_timeout_preserves_official_grade_and_cleanup(self):
        self.exercise(True)
