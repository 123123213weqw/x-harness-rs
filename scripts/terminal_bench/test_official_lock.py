import json
from pathlib import Path
import unittest
from urllib.parse import urlsplit


class OfficialLockTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).parent
        self.manifest = json.loads((root / 'official-package.json').read_text())
        self.lock = json.loads((root / 'official-package-lock.json').read_text())

    def test_manifest_matches_lock_root(self):
        self.assertEqual(self.manifest['dependencies'], self.lock['packages']['']['dependencies'])
        self.assertGreater(len(self.manifest['dependencies']), 200)

    def test_every_artifact_has_public_url_and_integrity(self):
        for name, package in self.lock['packages'].items():
            if not name:
                continue
            with self.subTest(package=name):
                url = urlsplit(package['resolved'])
                self.assertEqual((url.scheme, url.hostname), ('https', 'registry.npmjs.org'))
                self.assertIsNone(url.username)
                self.assertTrue(package['integrity'].startswith('sha512-'))

    def test_official_components_are_exactly_pinned(self):
        for name, version in self.manifest['dependencies'].items():
            if name.startswith('@deepseek-ai/dsh'):
                self.assertEqual(version, '0.1.5-rc.1')
                self.assertEqual(self.lock['packages']['node_modules/' + name]['version'], version)
