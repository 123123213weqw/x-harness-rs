"""Portable manifest gate. Does not compile or execute Rust."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]

class ManifestTests(unittest.TestCase):
    def test_all_executable_targets_receive_manifest(self):
        build = (ROOT / 'apps/desktop/src-tauri/build.rs').read_text()
        self.assertIn('cargo:rustc-link-arg=/MANIFEST:EMBED', build)
        self.assertIn('cargo:rustc-link-arg=/MANIFESTINPUT:', build)
        self.assertNotIn('cargo:rustc-link-arg-examples=', build)
        self.assertIn('target.ends_with("windows-msvc")', build)

    def test_dependency_only_does_not_override_production_identity_or_privileges(self):
        root = ET.parse(ROOT / 'apps/desktop/src-tauri/windows-common-controls.manifest').getroot()
        ns = {'a': 'urn:schemas-microsoft-com:asm.v1'}
        self.assertIsNone(root.find('a:assemblyIdentity', ns))
        dep = root.find('a:dependency/a:dependentAssembly/a:assemblyIdentity', ns)
        self.assertIsNotNone(dep)
        self.assertEqual(dep.attrib['name'], 'Microsoft.Windows.Common-Controls')
        self.assertEqual(dep.attrib['version'], '6.0.0.0')
        self.assertEqual(dep.attrib['publicKeyToken'], '6595b64144ccf1df')
        self.assertNotIn('requestedExecutionLevel', ET.tostring(root, encoding='unicode'))

    def test_native_unit_manifest_is_inspected_before_execution(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn('xharness_desktop-*.exe', workflow)
        self.assertIn('unit activation/import evidence', workflow)
        self.assertIn('cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets', workflow)

if __name__ == '__main__':
    unittest.main()
