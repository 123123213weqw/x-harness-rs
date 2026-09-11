import hashlib
from pathlib import Path
import tempfile
import unittest
from preflight_oracle import verify_bundle


class BundleTests(unittest.TestCase):
    def test_bundle_must_match_expected_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.bundle'
            path.write_bytes(b'fixture')
            expected = hashlib.sha256(b'fixture').hexdigest()
            self.assertEqual(verify_bundle(path, expected), expected)
            for invalid in (None, '', '0' * 64, 'g' * 64, expected.upper()):
                with self.subTest(expected=invalid), self.assertRaises(ValueError):
                    verify_bundle(path, invalid)
