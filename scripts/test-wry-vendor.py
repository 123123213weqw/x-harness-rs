"""Mutation tests for the vendored-source gate; never compiles Rust."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('wry_vendor', ROOT / 'scripts/check-wry-vendor.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class WryVendorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.desktop = self.root / 'apps/desktop/src-tauri'
        self.desktop.mkdir(parents=True)
        source = ROOT / 'apps/desktop/src-tauri'
        shutil.copytree(source / 'vendor', self.desktop / 'vendor')
        for name in ['Cargo.toml', 'Cargo.lock']:
            shutil.copyfile(source / name, self.desktop / name)

    def test_pinned_source_and_patch_are_complete(self):
        self.assertEqual(gate.verify(self.root)['modifiedUpstreamFiles'], ['src/wkwebview/mod.rs'])

    def test_unmodified_upstream_source_cannot_drift(self):
        with (self.desktop / 'vendor/wry/src/lib.rs').open('a') as file:
            file.write('\n// unexpected change\n')
        with self.assertRaisesRegex(ValueError, 'source drift'):
            gate.verify(self.root)

    def test_modified_backend_is_also_pinned(self):
        with (self.desktop / 'vendor/wry/src/wkwebview/mod.rs').open('a') as file:
            file.write('\n// unexpected change\n')
        with self.assertRaisesRegex(ValueError, 'source drift'):
            gate.verify(self.root)

    def test_missing_license_or_extra_source_is_rejected(self):
        license = self.desktop / 'vendor/wry/LICENSE-MIT'
        original = license.read_bytes()
        license.unlink()
        with self.assertRaisesRegex(ValueError, 'files missing'):
            gate.verify(self.root)
        license.write_bytes(original)
        (self.desktop / 'vendor/wry/src/unreviewed.rs').write_text('')
        with self.assertRaisesRegex(ValueError, 'source drift'):
            gate.verify(self.root)

    def test_registry_fallback_or_duplicate_wry_is_rejected(self):
        path = self.desktop / 'Cargo.lock'
        with path.open('a') as file:
            file.write('\n[[package]]\nname = "wry"\nversion = "0.55.1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n')
        with self.assertRaisesRegex(ValueError, 'lockfile'):
            gate.verify(self.root)

    def test_provenance_cannot_expand_the_patch_surface(self):
        path = self.desktop / 'vendor/wry/XHARNESS-PROVENANCE.json'
        data = json.loads(path.read_text())
        data['patchedFiles']['src/lib.rs'] = {'sha256': '0' * 64}
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'only the nullable-URL'):
            gate.verify(self.root)


if __name__ == '__main__':
    unittest.main()
