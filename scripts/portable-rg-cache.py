#!/usr/bin/env python3
"""CI-only portable search cache. A receipt detects corruption, not authenticity.

Only successful trusted-master workflows write the cache; PRs are restore-only.
The binary digest and build identity are checked before executing restored code.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[1]
VERSION = '15.2.0'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def identity():
    return {'schema': 1, 'version': VERSION, 'system': platform.system(),
            'machine': platform.machine(), 'toolchain': tomllib.loads((ROOT / 'rust-toolchain.toml').read_text())['toolchain']['channel'],
            'rustc': subprocess.check_output(['rustc', '-vV'], text=True),
            'config': digest(ROOT / '.cargo/config.toml'),
            'flags': {k: v for k, v in os.environ.items() if k.startswith(('RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_PROFILE_RELEASE_'))}}


def valid(root, expected):
    binary, receipt = root / 'bin/rg', root / 'receipt.json'
    try:
        if root.is_symlink() or binary.parent.is_symlink() or binary.is_symlink() or receipt.is_symlink():
            return False
        if not binary.is_file() or not 0 < binary.stat().st_size <= 32 * 1024 * 1024:
            return False
        if not receipt.is_file() or not 0 < receipt.stat().st_size <= 16 * 1024:
            return False
        saved = json.loads(receipt.read_text())
        if saved != {**expected, 'binary_sha256': digest(binary)}:
            return False
        if expected['system'] == 'Darwin':
            header = binary.read_bytes()[:8]
            cpu = {'x86_64': 0x01000007, 'arm64': 0x0100000c}.get(expected['machine'])
            if cpu is None or len(header) != 8 or struct.unpack('<II', header) != (0xfeedfacf, cpu):
                return False
        output = subprocess.check_output([str(binary), '--version'], text=True, timeout=10)
        return output.splitlines()[0].split()[:2] == ['ripgrep', VERSION] and '+PCRE2' not in output
    except (OSError, ValueError, subprocess.SubprocessError, IndexError):
        return False


def ensure(root, expected):
    if valid(root, expected):
        return True
    if root.is_symlink():
        raise ValueError('Portable search root cannot be a symlink')
    if root.exists():
        shutil.rmtree(root)
    subprocess.run(['cargo', 'install', 'ripgrep', '--version', VERSION, '--locked',
                    '--no-default-features', '--root', str(root)], check=True)
    (root / 'receipt.json').write_text(json.dumps({**expected, 'binary_sha256': digest(root / 'bin/rg')}, sort_keys=True) + '\n')
    if not valid(root, expected):
        raise ValueError('Fresh portable search binary failed verification')
    return False


def main():
    if os.environ.get('CI') != 'true':
        raise ValueError('Build ripgrep on remote/CI only')
    parent = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    root = parent / 'xharness-portable-rg'
    reused = ensure(root, identity())
    print('portable-rg: verified cache reuse' if reused else 'portable-rg: built and verified')
    with open(os.environ['GITHUB_PATH'], 'a') as stream:
        stream.write(str(root / 'bin') + '\n')


if __name__ == '__main__':
    main()
