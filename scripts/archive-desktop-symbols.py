#!/usr/bin/env python3
"""Archive exact Windows binary/PDB pairs, separately from user installers.

No credentials or runtime data are read. Fail closed on missing/mismatched PDBs.
The same script serves CI and release builds; archives require durable retention
by maintainers, since GitHub Actions retention alone is time-limited.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import uuid
import zipfile


def pdb_identity(data):
    if not data.startswith(b'Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0'):
        raise ValueError('not a PDB 7.0 file')
    block, _, _, directory_bytes, _, block_map = struct.unpack_from('<6I', data, 32)
    if block < 512 or block > 65536 or block & (block - 1) or directory_bytes > len(data):
        raise ValueError('invalid PDB directory bounds')
    def take_blocks(indices, length):
        result = b''.join(data[index * block:(index + 1) * block] for index in indices)
        if len(result) < length:
            raise ValueError('truncated PDB blocks')
        return result[:length]
    n = (directory_bytes + block - 1) // block
    indices = struct.unpack_from(f'<{n}I', data, block_map * block)
    directory = take_blocks(indices, directory_bytes)
    streams, = struct.unpack_from('<I', directory)
    if streams < 2 or streams > len(directory) // 4:
        raise ValueError('invalid PDB stream count')
    sizes = struct.unpack_from(f'<{streams}I', directory, 4)
    offset = 4 + streams * 4
    for stream, size in enumerate(sizes):
        count = 0 if size == 0xffffffff else (size + block - 1) // block
        indices = struct.unpack_from(f'<{count}I', directory, offset)
        offset += count * 4
        if stream == 1:
            info = take_blocks(indices, size)
            age, = struct.unpack_from('<I', info, 8)
            return info[12:28], age
    raise ValueError('PDB identity stream not found')


def verify_pair(binary, pdb):
    guid, age = pdb_identity(pdb)
    if len(guid) != 16 or b'RSDS' + guid + struct.pack('<I', age) not in binary:
        raise ValueError('binary and PDB GUID/age do not match')
    return {'guid': str(uuid.UUID(bytes_le=guid)), 'age': age}


def archive(root, target, output):
    root = root.resolve()
    output.mkdir(parents=True, exist_ok=False)
    inventory = []
    directories = [root / 'target' / target / 'release', root / 'apps/desktop/src-tauri/target' / target / 'release']
    for name, directory in zip(('xharness-host', 'xharness-desktop'), directories):
        binary = directory / (name + '.exe')
        pdb = directory / (name.replace('-', '_') + '.pdb')
        identity = verify_pair(binary.read_bytes(), pdb.read_bytes())
        for path in (binary, pdb):
            shutil.copy2(path, output / path.name)
        inventory.append({'binary': binary.name, 'pdb': pdb.name, 'codeview': identity,
                          'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                          'pdbSha256': hashlib.sha256(pdb.read_bytes()).hexdigest()})
    manifest = {'format': 'xharness-windows-symbols-v1', 'target': target,
                'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
                'toolchain': subprocess.check_output(['rustc', '-Vv'], cwd=root, text=True),
                'pairs': inventory,
                'lockfiles': {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                              for name in ('Cargo.lock', 'apps/desktop/src-tauri/Cargo.lock')}}
    (output / 'symbols.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


def verify_archive(path, source):
    expected = {'symbols.json', 'xharness-host.exe', 'xharness_host.pdb', 'xharness-desktop.exe', 'xharness_desktop.pdb'}
    with zipfile.ZipFile(path) as archive_file:
        infos = archive_file.infolist()
        if len(infos) != len(expected) or {info.filename for info in infos} != expected or sum(info.file_size for info in infos) > 1024 ** 3:
            raise ValueError('unexpected symbol archive members or size')
        manifest = json.loads(archive_file.read('symbols.json'))
        if manifest['source'] != source or manifest['target'] != 'x86_64-pc-windows-msvc' or len(manifest['pairs']) != 2:
            raise ValueError('symbol source/target mismatch')
        if {pair['binary'] for pair in manifest['pairs']} != {'xharness-host.exe', 'xharness-desktop.exe'}:
            raise ValueError('incomplete symbol pairs')
        for pair in manifest['pairs']:
            binary, pdb = archive_file.read(pair['binary']), archive_file.read(pair['pdb'])
            if hashlib.sha256(binary).hexdigest() != pair['binarySha256'] or hashlib.sha256(pdb).hexdigest() != pair['pdbSha256']:
                raise ValueError('symbol archive checksum mismatch')
            if verify_pair(binary, pdb) != pair['codeview']:
                raise ValueError('symbol archive identity mismatch')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--target', default='x86_64-pc-windows-msvc')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    archive(args.root, args.target, args.output)
    with zipfile.ZipFile(args.output.with_suffix('.zip'), 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
        for path in sorted(args.output.iterdir()):
            zipped.write(path, path.name)
