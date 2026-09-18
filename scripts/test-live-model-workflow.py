"""Offline contract for manual live-model CI; never sends credentials/requests."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / '.github/workflows/live-model-acceptance.yml').read_text()


def validate(source):
    declarations = set(re.findall(r'^      ([a-zA-Z_][a-zA-Z0-9_]*):\s*$', source, re.M))
    references = set(re.findall(r'\binputs\.([a-zA-Z_][a-zA-Z0-9_]*)', source))
    if references - declarations:
        raise ValueError(f'undeclared workflow inputs: {sorted(references - declarations)}')
    keys = re.findall(r'^\s+XHARNESS_LIVE_API_KEY:\s*(.*?)\s*$', source, re.M)
    if len(keys) != 4 or any(key != '${{ secrets.XHARNESS_LIVE_API_KEY }}' for key in keys):
        raise ValueError('guard and all three live tests must use the same repository secret')
    if len(re.findall(r'run: cargo test --locked .* -- --ignored --nocapture', source)) != 3:
        raise ValueError('the three explicit live acceptance cases must remain present')


class LiveModelWorkflow(unittest.TestCase):
    def test_shipped_workflow(self):
        validate(SOURCE)

    def test_removed_input_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'undeclared'):
            validate(SOURCE.replace('${{ secrets.XHARNESS_LIVE_API_KEY }}',
                                    '${{ secrets[inputs.api_key_secret] }}', 1))

    def test_mismatched_secret_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'same repository secret'):
            validate(SOURCE.replace('${{ secrets.XHARNESS_LIVE_API_KEY }}',
                                    '${{ secrets.OTHER_API_KEY }}', 1))

    def test_missing_test_credential_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'same repository secret'):
            validate(SOURCE.replace('XHARNESS_LIVE_API_KEY:', 'MISSING_KEY:', 1))


if __name__ == '__main__':
    unittest.main()
