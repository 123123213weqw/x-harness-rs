#!/usr/bin/env python3
"""不编译 Rust，只在临时副本中测试版本和签名公钥的打包投影。"""
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare', ROOT / 'scripts/prepare-desktop-test-version.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseProjection(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.desktop = self.root / 'apps/desktop/src-tauri'
        self.desktop.mkdir(parents=True)
        for name in ('Cargo.toml', 'Cargo.lock', 'tauri.conf.json'):
            shutil.copy(ROOT / 'apps/desktop/src-tauri' / name, self.desktop / name)
        module.ROOT = self.root

    def tearDown(self):
        self.temp.cleanup()

    def test_bundler_receives_same_public_key_and_all_versions_change(self):
        module.prepare('0.1.2', 'test-public-key\n')
        config = json.loads((self.desktop / 'tauri.conf.json').read_text())
        self.assertEqual(config['plugins']['updater']['pubkey'], 'test-public-key')
        self.assertEqual(config['version'], '0.1.2')
        self.assertIn('name = "xharness-desktop"\nversion = "0.1.2"', (self.desktop / 'Cargo.lock').read_text())
        self.assertIn('version = "0.1.2"', (self.desktop / 'Cargo.toml').read_text())

    def test_empty_key_and_invalid_versions_are_rejected(self):
        with self.assertRaises(ValueError):
            module.prepare('0.1.2', '  ')
        for version in ('1; echo bad', '01.2.3', '1.2', 'v0.1.2', '1.2.3\n'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                module.prepare(version, 'key')

    def test_formal_workflow_configures_key_before_packaging(self):
        source = (ROOT / '.github/workflows/desktop-release.yml').read_text()
        self.assertLess(source.index('Project updater public key into bundler config'), source.index('Build, sign and publish desktop bundle'))


if __name__ == '__main__':
    unittest.main()
