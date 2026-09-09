#!/usr/bin/env python3
"""不编译 Rust，只在临时副本中测试版本和签名公钥的打包投影。"""
import importlib.util
import json
import shutil
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare', ROOT / 'scripts/prepare-desktop-test-version.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

stage_spec = importlib.util.spec_from_file_location('stage', ROOT / 'scripts/stage-tauri-sidecar.py')
stage = importlib.util.module_from_spec(stage_spec)
stage_spec.loader.exec_module(stage)


class PortableSearch(unittest.TestCase):
    def test_macos_accepts_only_system_libraries_and_executes_binary(self):
        with patch.object(stage.sys, 'platform', 'darwin'), \
             patch.object(stage.subprocess, 'check_output', return_value='rg:\n /usr/lib/libSystem.B.dylib (version 1)\n'), \
             patch.object(stage.subprocess, 'run') as run:
            stage.validate_macos_rg(Path('/fixture/rg'))
            run.assert_called_once()

    def test_homebrew_relative_and_empty_linkage_fail_before_execution(self):
        for library in ('/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib',
                        '/usr/local/opt/pcre2/lib/libpcre2-8.0.dylib',
                        '@rpath/libpcre2-8.0.dylib', ''):
            output = 'rg:\n' + (f' {library} (version 1)\n' if library else '')
            with self.subTest(library=library), \
                 patch.object(stage.sys, 'platform', 'darwin'), \
                 patch.object(stage.subprocess, 'check_output', return_value=output), \
                 patch.object(stage.subprocess, 'run') as run, self.assertRaises(ValueError):
                stage.validate_macos_rg(Path('/fixture/rg'))
            run.assert_not_called()

    def test_real_search_dependencies_are_installed_before_workspace_tests(self):
        source = (ROOT / '.github/workflows/ci.yml').read_text()
        for job, dependency in [('rust-linux', 'Install search integration test dependency'),
                                ('rust-windows', 'Install pinned ripgrep'),
                                ('rust-macos-arm64', 'Install portable search')]:
            body = source.split('  ' + job + ':', 1)[1]
            self.assertLess(body.index(dependency), body.index('cargo test --workspace'))
        source = (ROOT / '.github/workflows/desktop-update-test.yml').read_text()
        self.assertLess(source.index('bash scripts/install-portable-rg.sh'), source.index('cargo test --locked --workspace'))
        source = (ROOT / '.github/workflows/friends-release.yml').read_text()
        self.assertLess(source.index('Install pinned ripgrep'), source.index('cargo test --locked --workspace'))

    def test_all_mac_packaging_paths_use_portable_rg(self):
        for name in ('ci.yml', 'desktop-release.yml', 'desktop-update-test.yml',
                     'desktop-unix-update-acceptance.yml'):
            source = (ROOT / '.github/workflows' / name).read_text()
            self.assertIn('scripts/install-portable-rg.sh', source, name)
            self.assertNotIn('brew install ripgrep', source, name)
        source = (ROOT / 'scripts/test-desktop-assets.py').read_text()
        self.assertIn('otool', source)
        self.assertIn('signed-sidecar-fixture', source)


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
        config = json.loads((self.desktop / 'tauri.conf.json').read_text(encoding='utf-8'))
        self.assertEqual(config['plugins']['updater']['pubkey'], 'test-public-key')
        self.assertEqual(config['version'], '0.1.2')
        self.assertIn('name = "xharness-desktop"\nversion = "0.1.2"', (self.desktop / 'Cargo.lock').read_text(encoding='utf-8'))
        self.assertIn('version = "0.1.2"', (self.desktop / 'Cargo.toml').read_text(encoding='utf-8'))

    def test_empty_key_and_invalid_versions_are_rejected(self):
        with self.assertRaises(ValueError):
            module.prepare('0.1.2', '  ')
        for version in ('1; echo bad', '01.2.3', '1.2', 'v0.1.2', '1.2.3\n'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                module.prepare(version, 'key')

    def test_formal_workflow_configures_key_before_packaging(self):
        source = (ROOT / '.github/workflows/desktop-release.yml').read_text(encoding='utf-8')
        self.assertLess(source.index('Project updater public key into bundler config'), source.index('Build and sign desktop bundle (artifacts only)'))
        self.assertIn('needs: [plan, build]', source)
        self.assertIn('Stage one complete draft, never latest', source)
        self.assertNotIn('uploadUpdaterJson: true', source)


if __name__ == '__main__':
    unittest.main()
