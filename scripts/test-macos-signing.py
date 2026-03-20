"""No native signing or credentials: verify policy command/identity contracts."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('macos_signing', Path(__file__).with_name('macos-signing.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class SigningPolicy(unittest.TestCase):
    def result(self, detail):
        return subprocess.CompletedProcess([], 0, b'', detail.encode())

    def test_preview_verifies_code_signature_without_claiming_apple_approval(self):
        with patch.object(m.subprocess, 'run', return_value=self.result('Signature=adhoc\n')) as run:
            checks = m.verify(Path('fixture.app'), preview=True)
        self.assertEqual(checks, {'codesignVerified': True, 'adHocSignatureVerified': True})
        commands = [call.args[0] for call in run.call_args_list]
        self.assertIn('--verify', commands[0])
        self.assertIn('--deep', commands[0])
        self.assertIn('--strict', commands[0])
        self.assertEqual([command[0] for command in commands], ['codesign', 'codesign'])
        self.assertTrue(all(call.kwargs['check'] for call in run.call_args_list))
        self.assertTrue(all(call.kwargs['timeout'] == 90 for call in run.call_args_list))

    def test_invalid_unsigned_or_wrong_identity_never_passes(self):
        for detail in ('', 'Signature=adhoc-invalid\n', 'Authority=Developer ID Application: Example\n'):
            with self.subTest(detail=detail), patch.object(m.subprocess, 'run', return_value=self.result(detail)), self.assertRaises(ValueError):
                m.verify(Path('fixture.app'), preview=True)
        with patch.object(m.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['codesign'])), self.assertRaises(subprocess.CalledProcessError):
            m.verify(Path('fixture.app'), preview=True)
        with patch.object(m.subprocess, 'run', side_effect=subprocess.TimeoutExpired(['codesign'], 90)), self.assertRaises(subprocess.TimeoutExpired):
            m.verify(Path('fixture.app'), preview=True)

    def test_default_still_requires_developer_id_gatekeeper_and_stapled_notarization(self):
        with patch.object(m.subprocess, 'run', return_value=self.result('Signature=adhoc\n')), self.assertRaises(ValueError):
            m.verify(Path('fixture.app'))
        detail = 'Authority=Developer ID Application: Example\nTeamIdentifier=ABCDEFGHIJ\n'
        with patch.object(m.subprocess, 'run', return_value=self.result(detail)) as run:
            checks = m.verify(Path('fixture.app'), team='ABCDEFGHIJ')
        self.assertEqual(set(checks), {'codesignVerified', 'gatekeeperAccepted', 'notarizationStapleVerified'})
        self.assertEqual([call.args[0][0] for call in run.call_args_list], ['codesign', 'codesign', 'spctl', 'xcrun'])
        for team in ('ZZZZZZZZZZ', 'bad'):
            with patch.object(m.subprocess, 'run', return_value=self.result(detail)), self.assertRaises(ValueError):
                m.verify(Path('fixture.app'), team=team)


if __name__ == '__main__':
    unittest.main()
