import importlib.util
from pathlib import Path
import struct
import unittest
import tempfile
import zipfile
import json
import hashlib

spec = importlib.util.spec_from_file_location('symbols', Path(__file__).with_name('archive-desktop-symbols.py'))
symbols = importlib.util.module_from_spec(spec)
spec.loader.exec_module(symbols)


def fixture():
    data = bytearray(512 * 4)
    data[:32] = b'Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0'
    struct.pack_into('<6I', data, 32, 512, 0, 4, 16, 0, 1)
    struct.pack_into('<I', data, 512, 2)
    struct.pack_into('<4I', data, 1024, 2, 0, 28, 3)
    guid = bytes(range(16))
    struct.pack_into('<3I', data, 1536, 20000404, 0, 1)
    data[1548:1564] = guid
    return bytes(data), b'MZ...RSDS' + guid + struct.pack('<I', 1) + b'host.pdb\0'


def archive_fixture(path, source='a' * 40):
    pdb, exe = fixture()
    pairs = []
    with zipfile.ZipFile(path, 'w') as zipped:
        for name in ('xharness-host', 'xharness-desktop'):
            binary_name, pdb_name = name + '.exe', name.replace('-', '_') + '.pdb'
            zipped.writestr(binary_name, exe); zipped.writestr(pdb_name, pdb)
            pairs.append({'binary': binary_name, 'pdb': pdb_name, 'codeview': symbols.verify_pair(exe, pdb),
                          'binarySha256': hashlib.sha256(exe).hexdigest(), 'pdbSha256': hashlib.sha256(pdb).hexdigest()})
        zipped.writestr('symbols.json', json.dumps({'source': source, 'target': 'x86_64-pc-windows-msvc', 'pairs': pairs}))


class Symbols(unittest.TestCase):
    def test_archive_source_and_allowlisted_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'symbols.zip'
            archive_fixture(path)
            self.assertEqual(symbols.verify_archive(path, 'a' * 40)['source'], 'a' * 40)
            with self.assertRaises(ValueError): symbols.verify_archive(path, 'b' * 40)
            with zipfile.ZipFile(path, 'a') as zipped: zipped.writestr('private.env', 'do not include')
            with self.assertRaises(ValueError): symbols.verify_archive(path, 'a' * 40)
    def test_matching_identity(self):
        pdb, exe = fixture()
        self.assertEqual(symbols.verify_pair(exe, pdb)['age'], 1)

    def test_wrong_build_is_rejected(self):
        pdb, exe = fixture()
        with self.assertRaises(ValueError):
            symbols.verify_pair(exe.replace(bytes(range(16)), b'x' * 16), pdb)

    def test_missing_or_truncated_symbols_fail(self):
        pdb, exe = fixture()
        for broken in (b'', b'fake pdb', pdb[:300]):
            with self.assertRaises((ValueError, struct.error)):
                symbols.verify_pair(exe, broken)

    def test_release_archives_symbols_outside_installer(self):
        workflow = Path(__file__).parents[1].joinpath('.github/workflows/desktop-release.yml').read_text(encoding='utf-8')
        self.assertIn('CARGO_PROFILE_RELEASE_DEBUG', workflow)
        self.assertIn('archive-desktop-symbols.py', workflow)
        self.assertIn('desktop-symbols-windows', workflow)
        self.assertIn('attach-desktop-symbols.py', workflow)
        self.assertLess(workflow.index('attach-desktop-symbols.py'), workflow.index('Stage one complete draft'))


if __name__ == '__main__':
    unittest.main()
