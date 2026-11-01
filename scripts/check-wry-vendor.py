#!/usr/bin/env python3
"""Verify the narrowly patched, version-pinned Wry source without network/builds."""
import argparse
import hashlib
import json
from pathlib import Path
import tomllib

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE_SHA256 = '186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514'
PATCHED_FILE = 'src/wkwebview/mod.rs'


def verify(root=ROOT):
    desktop = Path(root) / 'apps/desktop/src-tauri'
    vendor = desktop / 'vendor/wry'
    manifest = json.loads((vendor / 'XHARNESS-PROVENANCE.json').read_text())
    if (manifest['crate'], manifest['version'], manifest['archiveSha256']) != ('wry', '0.55.1', ARCHIVE_SHA256):
        raise ValueError('unexpected Wry upstream identity')
    if set(manifest['patchedFiles']) != {PATCHED_FILE}:
        raise ValueError('only the nullable-URL backend may differ from upstream')
    expected = dict(manifest['upstreamFiles'])
    expected[PATCHED_FILE] = manifest['patchedFiles'][PATCHED_FILE]['sha256']
    actual = set()
    for path in vendor.rglob('*'):
        if path.is_symlink():
            raise ValueError('Wry source must not follow symlinks')
        if not path.is_file() or path.name == 'XHARNESS-PROVENANCE.json':
            continue
        relative = path.relative_to(vendor).as_posix()
        actual.add(relative)
        if relative not in expected or hashlib.sha256(path.read_bytes()).hexdigest() != expected[relative]:
            raise ValueError(f'Wry source drift: {relative}')
    if actual != set(expected):
        raise ValueError('Wry upstream files missing')
    cargo = tomllib.loads((desktop / 'Cargo.toml').read_text())
    if cargo.get('patch', {}).get('crates-io', {}).get('wry', {}).get('path') != 'vendor/wry':
        raise ValueError('desktop must resolve the patched Wry source')
    locked = [package for package in tomllib.loads((desktop / 'Cargo.lock').read_text())['package'] if package['name'] == 'wry']
    if len(locked) != 1 or locked[0]['version'] != '0.55.1' or 'source' in locked[0] or 'checksum' in locked[0]:
        raise ValueError('lockfile must select exactly the patched path package')
    return {'crate': 'wry', 'version': '0.55.1', 'upstreamFiles': len(expected), 'modifiedUpstreamFiles': [PATCHED_FILE]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    print(json.dumps(verify(parser.parse_args().root)))
