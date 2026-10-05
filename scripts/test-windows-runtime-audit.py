#!/usr/bin/env python3
"""Portable synthetic loader fixtures; never builds or executes a PE."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('audit-windows-runtime.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def fixture(imports=('kernel32.dll',), *, delay=False, machine=0x8664):
    data = bytearray(4096)
    data[:2] = b'MZ'
    struct.pack_into('<I', data, 60, 128)
    data[128:132] = b'PE\0\0'
    struct.pack_into('<HH', data, 132, machine, 1)
    struct.pack_into('<H', data, 148, 240)
    opt = 152
    struct.pack_into('<H', data, opt, 0x20b)
    struct.pack_into('<Q', data, opt + 24, 0x140000000)
    struct.pack_into('<I', data, opt + 60, 512)
    struct.pack_into('<I', data, opt + 108, 16)
    struct.pack_into('<IIII', data, opt + 240 + 8, 3584, 4096, 3584, 512)
    width, index = (32, 13) if delay else (20, 1)
    struct.pack_into('<II', data, opt + 112 + index * 8, 4096, width * (len(imports) + 1))
    name_pos = 768
    for i, name in enumerate(imports):
        rva = 4096 + name_pos - 512
        if delay:
            struct.pack_into('<II', data, 512 + i * width, 1, rva)
        else:
            struct.pack_into('<I', data, 512 + i * width + 12, rva)
        encoded = name.encode('ascii') + b'\0'
        data[name_pos:name_pos + len(encoded)] = encoded
        name_pos += len(encoded)
    return data


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in audit.REQUIRED:
            (self.root / name).write_bytes(fixture())

    def write(self, name, **kwargs):
        (self.root / name).write_bytes(fixture(**kwargs))

    def test_system_and_api_sets_allowed(self):
        self.write('xharness-host.exe', imports=('ucrtbase.dll', 'api-ms-win-core-file-l1-1-0.dll'))
        self.assertTrue(audit.audit(self.root)['passed'])

    def test_dynamic_owned_crt_rejected_even_if_packaged(self):
        for name in ('VCRUNTIME140.dll', 'MSVCP140.dll', 'vcruntime140_1.dll'):
            for delay in (False, True):
                with self.subTest(name=name, delay=delay):
                    self.write('xharness-host.exe', imports=(name,), delay=delay)
                    self.write(name)
                    with self.assertRaisesRegex(ValueError, 'dynamic MSVC'):
                        audit.audit(self.root)

    def test_third_party_dependency_must_be_present(self):
        self.write('rg.exe', imports=('VCRUNTIME140.dll',))
        with self.assertRaisesRegex(ValueError, 'Unpackaged'):
            audit.audit(self.root)
        self.write('VCRUNTIME140.dll')
        audit.audit(self.root)

    def test_nested_dll_does_not_satisfy_root_import(self):
        self.write('rg.exe', imports=('custom.dll',))
        (self.root / 'unrelated').mkdir()
        self.write('unrelated/custom.dll')
        with self.assertRaisesRegex(ValueError, 'Unpackaged'):
            audit.audit(self.root)

    def test_delay_import_dependency_checked(self):
        self.write('rg.exe', imports=('absent.dll',), delay=True)
        with self.assertRaisesRegex(ValueError, 'Unpackaged'):
            audit.audit(self.root)

    def test_architecture_and_missing_modules(self):
        self.write('rg.exe', machine=0x14c)
        with self.assertRaisesRegex(ValueError, 'Non-x64'):
            audit.audit(self.root)
        (self.root / 'rg.exe').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing root'):
            audit.audit(self.root)

    def test_stale_manifest_and_incomplete_manifest(self):
        expected = {name: audit.digest(self.root / name) for name in audit.REQUIRED}
        audit.audit(self.root, expected=expected)
        self.write('rg.exe', imports=('user32.dll',))
        with self.assertRaisesRegex(ValueError, 'Stale or mixed'):
            audit.audit(self.root, expected=expected)
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            audit.audit(self.root, expected={})

    def test_case_collision(self):
        # A case-insensitive filesystem cannot create this fixture; skip there.
        path = self.root / 'RG.EXE'
        path.write_bytes(fixture())
        if len(list(self.root.iterdir())) == len(audit.REQUIRED):
            self.skipTest('case-insensitive filesystem')
        with self.assertRaisesRegex(ValueError, 'Case-colliding'):
            audit.audit(self.root)

    def test_installer_plugins_are_not_app_runtime(self):
        (self.root / '$PLUGINSDIR').mkdir()
        self.write('$PLUGINSDIR/System.dll', machine=0x14c)
        self.assertEqual(len(audit.audit(self.root)['modules']), 4)

    def test_malformed_pe_fails_closed(self):
        for data in (b'', b'MZ', fixture()[:600]):
            with self.subTest(size=len(data)), self.assertRaises(ValueError):
                audit.PE(data).imports()
        data = fixture()
        struct.pack_into('<I', data, 512 + 12, 0xffffffff)
        with self.assertRaisesRegex(ValueError, 'RVA'):
            audit.PE(data).imports()

    def test_unterminated_and_incomplete_directory(self):
        data = fixture()
        struct.pack_into('<I', data, 152 + 112 + 8 + 4, 20)
        with self.assertRaisesRegex(ValueError, 'Unterminated'):
            audit.PE(data).imports()
        struct.pack_into('<I', data, 152 + 112 + 8 + 4, 0)
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            audit.PE(data).imports()

    def test_unsafe_import_name(self):
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            audit.PE(fixture(('../bad.dll',))).imports()

    def test_unknown_delay_attributes(self):
        data = fixture(delay=True)
        struct.pack_into('<I', data, 512, 2)
        with self.assertRaisesRegex(ValueError, 'attributes'):
            audit.PE(data).imports()

    def test_portable_host_does_not_require_desktop(self):
        (self.root / 'xharness-desktop.exe').unlink()
        self.assertTrue(audit.audit(self.root, desktop_required=False)['passed'])


if __name__ == '__main__':
    unittest.main()
