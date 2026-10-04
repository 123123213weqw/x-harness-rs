#!/usr/bin/env python3
"""Publish vetted public plugin data only; no shell, installers or credentials.

Immutable packages precede an atomic catalog switch. The fixed SSH receiver
uses a separate key and a destination outside the software update namespace.
"""
import argparse
import copy
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

ORIGIN = 'https://engine.xxdevs.com/plugins/'
SOURCE = 'https://raw.githubusercontent.com/123123213weqw/xharness-plugin-registry/main/'
MAX_TOTAL = 128 * 1024 * 1024
MAX_FILES = 250
ID = re.compile(r'[a-z0-9][a-z0-9._-]{0,79}')
SHA = re.compile(r'[a-f0-9]{64}')

def require(value, message):
    if not value:
        raise ValueError(message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()

def path_under(root, name):
    p = PurePosixPath(name)
    require(not p.is_absolute() and p.parts and '\\' not in name
            and all(x not in ('.', '..', '') and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', x) for x in p.parts), 'Unsafe path')
    value = root
    for part in p.parts:
        value = value / part
        require(not value.is_symlink(), 'Symlink denied')
    return value

def checked_zip(data, name):
    require(len(data) <= 64 * 1024 * 1024, 'Package too large')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        require(len(members) <= 2048 and sum(x.file_size for x in members) <= MAX_TOTAL, 'Expanded package quota exceeded')
        seen = set()
        for item in members:
            path = PurePosixPath(item.filename.rstrip('/'))
            require(not path.is_absolute() and '..' not in path.parts and '\\' not in item.filename
                    and item.filename not in seen and (item.external_attr >> 16) & 0o170000 != 0o120000, 'Unsafe ZIP member')
            seen.add(item.filename)
        manifests = [prefix + suffix for prefix in ['', name + '/'] for suffix in ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json']]
        manifest = next((x for x in manifests if x in seen), None)
        require(manifest is not None and len(archive.read(manifest)) <= 65536, 'Plugin manifest missing/too large')
        require(json.loads(archive.read(manifest))['name'] == name, 'Plugin manifest name differs')

def checked_svg(data):
    require(len(data) <= 64 * 1024 and b'<!DOCTYPE' not in data.upper() and b'<!ENTITY' not in data.upper(), 'Unsafe SVG')
    root = ET.fromstring(data)
    require(root.tag.split('}')[-1] == 'svg', 'Not an SVG')
    for node in root.iter():
        require(node.tag.split('}')[-1].lower() not in ('script', 'foreignobject', 'image', 'use',
                'style', 'animate', 'animatemotion', 'animatetransform', 'set', 'feimage'), 'Active SVG denied')
        require(all(not k.split('}')[-1].lower().startswith('on') and 'href' not in k.lower()
                    and 'url(' not in v.lower() for k, v in node.attrib.items()), 'Active SVG attributes denied')

def prepare(registry, output):
    registry = registry.resolve()
    revision = subprocess.check_output(['git', '-C', str(registry), 'rev-parse', 'HEAD'], text=True).strip()
    require(re.fullmatch(r'[a-f0-9]{40}', revision), 'Invalid public source revision')
    origin = subprocess.check_output(['git', '-C', str(registry), 'remote', 'get-url', 'origin'], text=True).strip()
    require(origin.rstrip('/') in ('https://github.com/123123213weqw/xharness-plugin-registry',
                                  'https://github.com/123123213weqw/xharness-plugin-registry.git'), 'Not the vetted public repository')
    source = path_under(registry, 'catalog.json').read_bytes()
    require(len(source) <= 2 * 1024 * 1024, 'Catalog too large')
    document = json.loads(source)
    entries = document['plugins']
    require(isinstance(entries, list) and 0 < len(entries) <= 100, 'Invalid catalog count')
    result = copy.deepcopy(document)
    files = {}; names = set()
    for item in result['plugins']:
        name, version, spec = item['name'], item['version'], item['source']
        require(ID.fullmatch(name) and ID.fullmatch(version) and name not in names, 'Invalid/duplicate plugin identity')
        names.add(name)
        relative = f'packages/{name}/{version}/plugin.zip'
        require(spec['source'] == 'url' and spec['type'] == 'zip' and spec['url'] == SOURCE + relative
                and SHA.fullmatch(spec['sha256']), 'Unvetted package source')
        data = path_under(registry, relative).read_bytes()
        require(digest(data) == spec['sha256'], 'Package digest differs')
        checked_zip(data, name); files[relative] = data
        spec['url'] = ORIGIN + relative
        spec.pop('mirrors', None)
        if item.get('icon'):
            require(item['icon'].startswith(SOURCE + 'icons/'), 'Unvetted icon source')
            data = path_under(registry, item['icon'][len(SOURCE):]).read_bytes()
            checked_svg(data)
            relative = 'icons/' + digest(data) + '.svg'
            files[relative] = data; item['icon'] = ORIGIN + relative
    files['catalog.json'] = encode(result)
    require(not output.exists(), 'Export destination must be new')
    output.mkdir(parents=True, mode=0o700)
    for name, data in files.items():
        target = path_under(output, name); target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    manifest = {'schema_version': 1, 'revision': revision,
                'files': {name: {'sha256': digest(data), 'size': len(data)} for name, data in files.items()}}
    (output / 'manifest.json').write_bytes(encode(manifest))
    verify(output)
    return {'revision': revision, 'plugins': len(entries), 'files': len(files),
            'bytes': sum(len(data) for data in files.values()), 'catalog_sha256': digest(files['catalog.json'])}

def verify(root):
    manifest_data = path_under(root, 'manifest.json').read_bytes()
    require(len(manifest_data) <= 256 * 1024, 'Manifest too large')
    manifest = json.loads(manifest_data)
    require(manifest['schema_version'] == 1 and re.fullmatch(r'[a-f0-9]{40}', manifest['revision']), 'Invalid manifest')
    files = manifest['files']
    require(isinstance(files, dict) and 'catalog.json' in files and 0 < len(files) <= MAX_FILES, 'Invalid export inventory')
    require(sum(v['size'] for v in files.values()) <= MAX_TOTAL, 'Export quota exceeded')
    actual = set()
    for path in root.rglob('*'):
        require(not path.is_symlink(), 'Export symlink denied')
        if path.is_file(): actual.add(path.relative_to(root).as_posix())
    require(actual == set(files) | {'manifest.json'}, 'Unexpected export files')
    for name, record in files.items():
        require(name == 'catalog.json' or name.startswith(('packages/', 'icons/')), 'Unexpected export namespace')
        require(SHA.fullmatch(record['sha256']) and type(record['size']) is int and 0 <= record['size'] <= MAX_TOTAL, 'Invalid file record')
        data = path_under(root, name).read_bytes()
        require(len(data) == record['size'] and digest(data) == record['sha256'], 'Export bytes differ')
    catalog_data = (root / 'catalog.json').read_bytes()
    require(len(catalog_data) <= 2 * 1024 * 1024, 'Catalog too large')
    entries = json.loads(catalog_data)['plugins']; names = set(); referenced = {'catalog.json'}
    require(isinstance(entries, list) and 0 < len(entries) <= 100, 'Invalid catalog count')
    for entry in entries:
        name, version, spec = entry['name'], entry['version'], entry['source']
        require(ID.fullmatch(name) and ID.fullmatch(version) and name not in names, 'Invalid plugin identity')
        names.add(name); relative = f'packages/{name}/{version}/plugin.zip'; referenced.add(relative)
        require(spec['source'] == 'url' and spec['type'] == 'zip' and spec['url'] == ORIGIN + relative
                and files[relative]['sha256'] == spec['sha256'] and 'mirrors' not in spec, 'Catalog/package binding differs')
        checked_zip(path_under(root, relative).read_bytes(), name)
        if entry.get('icon'):
            require(entry['icon'].startswith(ORIGIN + 'icons/'), 'Invalid icon namespace')
            relative = entry['icon'][len(ORIGIN):]; referenced.add(relative)
            require(relative == 'icons/' + files[relative]['sha256'] + '.svg', 'Icon digest binding differs')
            checked_svg(path_under(root, relative).read_bytes())
    require(referenced == set(files), 'Unreferenced public files denied')
    return manifest

def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.plugin-stage-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if os.path.exists(name): os.unlink(name)

def publish(export, destination, state):
    manifest = verify(export)
    require(destination.name == 'plugins' and not destination.is_symlink(), 'Dedicated plugins destination required')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(not state.is_symlink() and not state.resolve().is_relative_to(destination.resolve()), 'Private state must be outside public root')
    with (state / 'publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Preflight the complete immutable set before any write. Existing
        # versions with different bytes are a conflict, never overwritten.
        for name, record in manifest['files'].items():
            target = path_under(destination, name)
            if name != 'catalog.json' and target.exists():
                require(target.is_file() and digest(target.read_bytes()) == record['sha256'], 'Immutable publication conflict')
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        previous = path_under(destination, 'catalog.json')
        if previous.exists(): atomic(state / ('catalog-' + digest(previous.read_bytes()) + '.json'), previous.read_bytes())
        for name in manifest['files']:
            if name != 'catalog.json':
                target = path_under(destination, name)
                if not target.exists(): atomic(target, path_under(export, name).read_bytes())
        atomic(previous, (export / 'catalog.json').read_bytes())
        atomic(state / 'receipt.json', encode(manifest))
    return {'published': True, 'revision': manifest['revision'], 'files': len(manifest['files'])}

def bundle(export, output):
    manifest = verify(export)
    with tarfile.open(output, 'w', format=tarfile.USTAR_FORMAT) as archive:
        for name in ['manifest.json', *sorted(manifest['files'])]:
            data = path_under(export, name).read_bytes()
            member = tarfile.TarInfo(name); member.size = len(data); member.mode = 0o600
            archive.addfile(member, io.BytesIO(data))
    return {'manifest': digest((export / 'manifest.json').read_bytes()), 'archive': digest(output.read_bytes())}

def smoke(export):
    manifest = verify(export)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args): return None
    opener = urllib.request.build_opener(NoRedirect)
    for name, record in manifest['files'].items():
        with opener.open(ORIGIN + name, timeout=30) as response:
            require(response.status == 200, 'Public file unavailable')
            data = response.read(record['size'] + 1)
            require(len(data) == record['size'] and digest(data) == record['sha256'], 'Public bytes differ')
    return {'public_verified': True, 'files': len(manifest['files']), 'revision': manifest['revision']}

def receive(destination, state, command, source):
    match = re.fullmatch(r'publish-plugins v1 ([a-f0-9]{64}) ([a-f0-9]{64})', command)
    require(match, 'Plugin publication command required; shell/SCP disabled')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='incoming-', dir=state) as temp:
        root = Path(temp); archive = root / 'upload.tar'; incoming = root / 'export'; incoming.mkdir()
        total = 0; hash_ = hashlib.sha256()
        with archive.open('xb') as target:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                total += len(chunk); require(total <= MAX_TOTAL + 2 * 1024 * 1024, 'Upload quota exceeded')
                hash_.update(chunk); target.write(chunk)
        require(hash_.hexdigest() == match[2], 'Upload digest differs')
        seen = set(); total = 0
        with tarfile.open(archive, 'r:') as stream:
            for item in stream:
                require(item.isfile() and not item.pax_headers and item.name not in seen and len(seen) <= MAX_FILES, 'Unsafe tar member')
                seen.add(item.name); total += item.size
                require(0 <= item.size <= MAX_TOTAL and total <= MAX_TOTAL, 'Extracted upload quota exceeded')
                target = path_under(incoming, item.name); target.parent.mkdir(parents=True, exist_ok=True)
                with stream.extractfile(item) as payload, target.open('xb') as output:
                    for chunk in iter(lambda: payload.read(1024 * 1024), b''): output.write(chunk)
        require(digest(path_under(incoming, 'manifest.json').read_bytes()) == match[1], 'Manifest digest differs')
        return publish(incoming, destination, state)

def main():
    os.umask(0o077)
    p = argparse.ArgumentParser(description=__doc__); sub = p.add_subparsers(dest='command', required=True)
    prepare_ = sub.add_parser('prepare'); prepare_.add_argument('--registry', type=Path, required=True); prepare_.add_argument('--output', type=Path, required=True)
    verify_ = sub.add_parser('verify'); verify_.add_argument('--export', type=Path, required=True)
    smoke_ = sub.add_parser('smoke'); smoke_.add_argument('--export', type=Path, required=True)
    bundle_ = sub.add_parser('bundle'); bundle_.add_argument('--export', type=Path, required=True); bundle_.add_argument('--output', type=Path, required=True)
    for name in ['publish', 'receive']:
        q = sub.add_parser(name); q.add_argument('--destination', type=Path, required=True); q.add_argument('--state', type=Path, required=True)
        if name == 'publish': q.add_argument('--export', type=Path, required=True)
    args = p.parse_args()
    try:
        if args.command == 'prepare': result = prepare(args.registry, args.output)
        elif args.command == 'verify': result = {'verified': True, 'revision': verify(args.export)['revision']}
        elif args.command == 'bundle': result = bundle(args.export, args.output)
        elif args.command == 'smoke': result = smoke(args.export)
        elif args.command == 'publish': result = publish(args.export, args.destination, args.state)
        else: result = receive(args.destination, args.state, os.environ.get('SSH_ORIGINAL_COMMAND', ''), sys.stdin.buffer)
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        # Never print arbitrary upload content, credential-bearing URLs or SSH
        # command text to public Actions logs.
        print('Plugin publication rejected (' + type(error).__name__ + '); inspect the private publisher state.', file=sys.stderr)
        return 2
    return 0

if __name__ == '__main__': sys.exit(main())
