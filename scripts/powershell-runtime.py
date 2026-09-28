#!/usr/bin/env python3
"""Pin, stage and verify the complete official portable PowerShell distribution.

No installed pwsh/.NET, third-party Python package, or executable downloaded from
the Internet is needed to stage it. Native execution is a separate Windows gate.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'runtime/powershell.lock.json'
STAGED = ROOT / 'apps/desktop/src-tauri/resources/powershell'
TARGET = 'x86_64-pc-windows-msvc'
MAX_ARCHIVE = 192 * 1024 * 1024
MAX_EXPANDED = 768 * 1024 * 1024
MAX_FILE = 256 * 1024 * 1024
MAX_FILES = 5000
MAX_MANIFEST = 1024 * 1024
CORE = ('pwsh.exe', 'pwsh.dll', 'pwsh.runtimeconfig.json', 'pwsh.deps.json',
        'hostfxr.dll', 'hostpolicy.dll', 'coreclr.dll', 'clrjit.dll',
        'System.Management.Automation.dll', 'LICENSE.txt', 'ThirdPartyNotices.txt')
NATIVE = ('pwsh.exe', 'hostfxr.dll', 'hostpolicy.dll', 'coreclr.dll', 'clrjit.dll')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def validate_lock(lock):
    require(isinstance(lock, dict) and set(lock) == {'schema', 'lts_series', 'version', 'archives'}, 'Invalid PowerShell lock fields')
    require(type(lock['schema']) is int and lock['schema'] == 1, 'Unsupported PowerShell lock schema')
    version = lock['version']
    require(isinstance(version, str) and re.fullmatch(r'[1-9]\d*\.\d+\.\d+', version), 'Invalid stable PowerShell version')
    require(lock['lts_series'] == '.'.join(version.split('.')[:2]), 'Version outside pinned LTS series')
    require(isinstance(lock['archives'], dict) and set(lock['archives']) == {TARGET}, 'Unsupported PowerShell target')
    asset = lock['archives'][TARGET]
    require(isinstance(asset, dict) and set(asset) == {'sha256', 'size'}, 'Invalid PowerShell archive fields')
    require(isinstance(asset['sha256'], str) and re.fullmatch('[0-9a-f]{64}', asset['sha256']), 'Invalid PowerShell SHA256')
    require(type(asset['size']) is int and 0 < asset['size'] <= MAX_ARCHIVE, 'Invalid PowerShell archive size')
    return lock


def load_lock(path=LOCK):
    require(Path(path).stat().st_size <= MAX_MANIFEST, 'Oversized PowerShell lock')
    return validate_lock(json.loads(Path(path).read_text(encoding='utf-8')))


def asset_name(lock):
    return f"PowerShell-{lock['version']}-win-x64.zip"


def release_url(lock, name=None):
    return f"https://github.com/PowerShell/PowerShell/releases/download/v{lock['version']}/{name or asset_name(lock)}"


def download(url, path, limit):
    require(url.startswith('https://github.com/PowerShell/PowerShell/releases/download/'), 'Untrusted runtime download URL')
    # Retry only transport failures. A digest/size mismatch never becomes a retry
    # or an unpinned download. Do not send repository credentials to asset hosts.
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response, Path(path).open('wb') as output:
                require(response.url.startswith('https://'), 'Insecure asset redirect')
                count = 0
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    count += len(chunk)
                    require(count <= limit, 'Runtime download exceeds size limit')
                    output.write(chunk)
            return
        except (OSError, TimeoutError):
            Path(path).unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def safe_relative(name):
    require(isinstance(name, str) and name and '\\' not in name, 'Unsafe runtime path')
    path = PurePosixPath(name)
    require(not path.is_absolute() and path.as_posix() == name and all(p not in ('', '.', '..') for p in path.parts), 'Non-canonical runtime path')
    for part in path.parts:
        require(not any(c in part for c in ':<>"|?*') and not any(ord(c) < 32 for c in part), 'Invalid Windows runtime path')
        require(not part.endswith((' ', '.')), 'Ambiguous Windows runtime path')
        require(not re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])', part.split('.')[0], re.I), 'Reserved Windows path')
    return path


def entries(archive):
    infos = archive.infolist()
    require(0 < len(infos) <= MAX_FILES, 'Invalid runtime ZIP entry count')
    seen, files, total = set(), [], 0
    for info in infos:
        name = info.filename[:-1] if info.is_dir() else info.filename
        safe_relative(name)
        key = name.casefold()
        require(key not in seen, 'Duplicate or case-colliding runtime ZIP path')
        seen.add(key)
        mode = info.external_attr >> 16
        require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR) and not info.flag_bits & 1, 'Redirecting or encrypted runtime ZIP entry')
        require(0 <= info.file_size <= MAX_FILE, 'Oversized runtime ZIP file')
        total += info.file_size
        require(total <= MAX_EXPANDED, 'Runtime ZIP exceeds expanded budget')
        if not info.is_dir():
            files.append(info)
    file_names = {i.filename.casefold() for i in files}
    for info in files:
        require(not any(parent.as_posix().casefold() in file_names for parent in PurePosixPath(info.filename).parents if parent.as_posix() != '.'), 'Runtime ZIP file/directory collision')
    require(all(name.casefold() in file_names for name in CORE), 'Incomplete portable PowerShell/.NET/licenses')
    return files


def no_redirects(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), 'Missing or redirecting runtime directory')
    for path in root.rglob('*'):
        require(not path.is_symlink(), 'Symlink in runtime payload')
        # Windows directory junctions are not necessarily is_symlink().
        require(not getattr(path.lstat(), 'st_file_attributes', 0) & 0x400, 'Reparse point in runtime payload')


def native_audit(version_root):
    spec = importlib.util.spec_from_file_location('runtime_pe', ROOT / 'scripts/audit-windows-runtime.py')
    pe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pe)
    pending, checked = list(NATIVE), set()
    while pending:
        name = pending.pop()
        if name in checked:
            continue
        checked.add(name)
        path = Path(version_root) / name
        require(path.is_file() and path.stat().st_size <= MAX_FILE, 'Missing native runtime module: ' + name)
        module = pe.PE(path.read_bytes())
        require(module.machine == 0x8664 and module.magic == 0x20b, 'Wrong native PowerShell architecture: ' + name)
        for dependency in module.imports():
            if not pe.system(dependency):
                # Windows names are case-insensitive even when staging on Linux.
                candidates = [p.name for p in Path(version_root).iterdir() if p.name.lower() == dependency]
                require(len(candidates) == 1, 'Unpackaged PowerShell loader dependency: ' + dependency)
                pending.append(candidates[0])
    return sorted(checked)


def verify(root, lock=None, expected_manifest=None, *, check_native=True):
    lock = validate_lock(lock) if lock is not None else load_lock()
    root = Path(root)
    no_redirects(root)
    manifest_path = root / 'manifest.json'
    require(manifest_path.is_file() and manifest_path.stat().st_size <= MAX_MANIFEST, 'Missing/oversized PowerShell manifest')
    if expected_manifest is not None:
        require(digest(manifest_path) == expected_manifest, 'Stale or mixed PowerShell manifest')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    require(isinstance(manifest, dict) and set(manifest) == {'schema', 'version', 'target', 'archive_sha256', 'files'}, 'Invalid runtime manifest fields')
    require(manifest['schema'] == 1 and manifest['version'] == lock['version'] and manifest['target'] == TARGET and manifest['archive_sha256'] == lock['archives'][TARGET]['sha256'], 'PowerShell payload differs from canonical pin')
    files = manifest['files']
    require(isinstance(files, dict) and 0 < len(files) <= MAX_FILES, 'Invalid runtime file manifest')
    expected, total = {'manifest.json'}, 0
    for name, record in files.items():
        safe_relative(name)
        require(name.startswith(lock['version'] + '/'), 'Runtime file outside version directory')
        require(isinstance(record, dict) and set(record) == {'size', 'sha256'}, 'Invalid runtime file receipt')
        require(type(record['size']) is int and 0 <= record['size'] <= MAX_FILE, 'Invalid runtime file size')
        require(isinstance(record['sha256'], str) and re.fullmatch('[0-9a-f]{64}', record['sha256']), 'Invalid runtime file digest')
        path = root / name
        require(path.is_file() and path.stat().st_size == record['size'] and digest(path) == record['sha256'], 'Corrupt/missing runtime file: ' + name)
        expected.add(name)
        total += record['size']
    require(total <= MAX_EXPANDED, 'Oversized runtime payload')
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    require(actual == expected, 'Unmanifested or missing runtime files')
    require(all(lock['version'] + '/' + name in files for name in CORE), 'Incomplete PowerShell runtime/licenses')
    native = native_audit(root / lock['version']) if check_native else []
    return {'version': lock['version'], 'target': TARGET, 'manifest_sha256': digest(manifest_path), 'files': files, 'native_modules': native}


def stage(root=STAGED, *, lock=None, archive=None, cache=None):
    lock = validate_lock(lock) if lock is not None else load_lock()
    root = Path(root)
    if root.exists():
        # Never overwrite an existing runtime (possibly in use). Invalid/stale
        # staging is an explicit error, not a PATH fallback or hot DLL update.
        return verify(root, lock)
    root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='powershell-', dir=root.parent) as temp:
        temp = Path(temp)
        if archive is None:
            cache = Path(cache or (Path(tempfile.gettempdir()) / 'xharness-powershell-downloads'))
            cache.mkdir(parents=True, exist_ok=True)
            archive = cache / asset_name(lock)
            if not archive.exists():
                # Unique download name; publish only a complete checked archive.
                downloaded = temp / 'download.zip'
                download(release_url(lock), downloaded, lock['archives'][TARGET]['size'])
                require(downloaded.stat().st_size == lock['archives'][TARGET]['size'] and digest(downloaded) == lock['archives'][TARGET]['sha256'], 'PowerShell archive SHA256/size mismatch')
                os.replace(downloaded, archive)
        archive = Path(archive)
        require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size == lock['archives'][TARGET]['size'] and digest(archive) == lock['archives'][TARGET]['sha256'], 'PowerShell archive SHA256/size mismatch')
        payload = temp / 'payload'
        version_root = payload / lock['version']
        version_root.mkdir(parents=True)
        files = {}
        with zipfile.ZipFile(archive) as z:
            for info in entries(z):
                path = version_root / info.filename
                path.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as source, path.open('xb') as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                files[path.relative_to(payload).as_posix()] = {'size': path.stat().st_size, 'sha256': digest(path)}
        manifest = {'schema': 1, 'version': lock['version'], 'target': TARGET, 'archive_sha256': lock['archives'][TARGET]['sha256'], 'files': dict(sorted(files.items()))}
        (payload / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        receipt = verify(payload, lock)
        # Directory move, not an in-place partial extraction. A racing existing
        # destination makes this fail; its files are never deleted/replaced.
        require(not root.exists(), 'Runtime staging destination appeared during extraction')
        payload.rename(root)
        return receipt


def proposed_lock(lock, releases):
    validate_lock(lock)
    versions = []
    for release in releases:
        if release.get('draft') or release.get('prerelease'):
            continue
        match = re.fullmatch(r'v(\d+\.\d+\.\d+)', release.get('tag_name', ''))
        if match and match[1].startswith(lock['lts_series'] + '.'):
            versions.append((tuple(map(int, match[1].split('.'))), release))
    if not versions:
        return None
    version, release = max(versions, key=lambda item: item[0])
    if version <= tuple(map(int, lock['version'].split('.'))):
        return None
    candidate = json.loads(json.dumps(lock))
    candidate['version'] = '.'.join(map(str, version))
    assets = [a for a in release.get('assets', []) if a.get('name') == asset_name(candidate)]
    require(len(assets) == 1, 'Missing/ambiguous official stable archive')
    asset = assets[0]
    require(asset.get('browser_download_url') == release_url(candidate), 'Unexpected official asset URL')
    digest_value = asset.get('digest', '')
    require(isinstance(digest_value, str) and re.fullmatch('sha256:[0-9a-f]{64}', digest_value), 'Official archive has no SHA256 receipt')
    candidate['archives'][TARGET] = {'sha256': digest_value[7:], 'size': asset.get('size')}
    return validate_lock(candidate)


def check_updates(lock_path, output):
    lock = load_lock(lock_path)
    result = subprocess.run(['gh', 'api', 'repos/PowerShell/PowerShell/releases?per_page=100'], check=True, capture_output=True, text=True, timeout=60)
    candidate = proposed_lock(lock, json.loads(result.stdout))
    if candidate is None:
        print('PowerShell LTS pin is current; no upgrade PR needed')
        return False
    with tempfile.TemporaryDirectory(prefix='powershell-upgrade-') as temp:
        temp = Path(temp)
        hashes = temp / 'hashes.sha256'
        download(release_url(candidate, 'hashes.sha256'), hashes, 128 * 1024)
        pattern = rf"^{candidate['archives'][TARGET]['sha256']}[ *]+{re.escape(asset_name(candidate))}$"
        require(any(re.fullmatch(pattern, line.strip(), re.I) for line in hashes.read_text(encoding='utf-8-sig').splitlines()), 'Official checksum file disagrees with release asset')
        stage(temp / 'verified', lock=candidate)
    Path(output).write_text(json.dumps(candidate, indent=2) + '\n', encoding='utf-8')
    print('Verified PowerShell LTS upgrade: ' + candidate['version'])
    return True


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=('stage', 'verify', 'check-updates'))
    p.add_argument('--lock', type=Path, default=LOCK)
    p.add_argument('--target', default=TARGET)
    p.add_argument('--output', type=Path, default=STAGED)
    p.add_argument('--archive', type=Path)
    p.add_argument('--cache', type=Path)
    args = p.parse_args()
    require(args.target == TARGET, 'Unsupported bundled PowerShell target')
    if args.action == 'check-updates':
        check_updates(args.lock, args.output)
    else:
        receipt = stage(args.output, lock=load_lock(args.lock), archive=args.archive, cache=args.cache) if args.action == 'stage' else verify(args.output, load_lock(args.lock))
        print(f"PowerShell {receipt['version']} verified: {len(receipt['files'])} files, native .NET runtime and licenses retained")


if __name__ == '__main__':
    main()
