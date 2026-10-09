#!/usr/bin/env python3
"""Project an accepted public desktop release into the Engine binary-only store.

No builds, installer execution, source deployment or service restarts. The existing
public release contract verifies packages; the server independently verifies the
flat, signed export and compare-and-swap pointer. See the deployment runbook.
"""
import argparse
import base64
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
REPO = '123123213weqw/x-harness-rs'
ORIGIN = 'https://engine.xxdevs.com'
KEY_HASH = '3ec1f86a3e8aa53e94ad3708b6b40222a08e69ac1c80ee1eaa5c24cbb4ffd83a'
# The original one-time bootstrap used an unmodified GitHub feed, not a signed
# domain projection. This exact existing anchor is the ONLY unsigned exception.
BOOTSTRAP_HASH = '98443c93fcd94e8c9b161bdbfaa29abe2cc930c59073c7b402e8834ad83689d5'
MAX_TOTAL = 4 * 1024 ** 3
MAX_METADATA = 1024 ** 2
PROMOTE_PATH = '.github/workflows/desktop-promote.yml'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


contract = module('engine_desktop_contract', 'desktop-release.py')
build = module('engine_desktop_build', 'desktop-release-build.py')
require = contract.require
sha = contract.sha256


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def decode(data):
    require(len(data) <= MAX_METADATA, 'Oversized metadata')
    result = json.loads(data.decode('utf-8-sig'), object_pairs_hook=unique)
    require(isinstance(result, dict), 'JSON object required')
    return result


def load(path):
    contract.regular_file(Path(path))
    require(Path(path).stat().st_size <= MAX_METADATA, 'Oversized metadata')
    return decode(Path(path).read_bytes())


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + '\n').encode()


def write(path, value):
    Path(path).write_bytes(encoded(value))


def version(value):
    require(isinstance(value, str) and re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value), 'Invalid stable version')
    return tuple(map(int, value.split('.')))


def package_names(manifest, *, origin):
    version(manifest.get('version'))
    fields = {'version', 'notes', 'pub_date', 'platforms'}
    require(set(manifest) == fields | ({'macos_distribution'} if 'macos_distribution' in manifest else set()),
            'Unsupported manifest fields (upgrade the receiver explicitly; never strip signing policy)')
    require(isinstance(manifest['notes'], str) and len(manifest['notes']) < 8192, 'Invalid release notes')
    require(isinstance(manifest['pub_date'], str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', manifest['pub_date']), 'Invalid publication date')
    datetime.datetime.strptime(manifest['pub_date'], '%Y-%m-%dT%H:%M:%SZ')
    require(manifest.get('macos_distribution') in {None, contract.MACOS_PREVIEW_POLICY}, 'Unsupported macOS distribution policy')
    platforms = manifest['platforms']
    require(isinstance(platforms, dict) and 'windows-x86_64' in platforms and set(platforms) <= set(contract.PLATFORMS), 'Invalid platform set')
    result = {}
    for platform, entry in platforms.items():
        name = contract.PLATFORMS[platform][1].format(version=manifest['version'])
        require(isinstance(entry, dict) and set(entry) == {'url', 'signature'}
                and isinstance(entry['signature'], str) and 0 < len(entry['signature']) < 8192, 'Invalid platform entry')
        expected = (f'{ORIGIN}/downloads/releases/{manifest["version"]}/{name}' if origin == 'engine'
                    else f'https://github.com/{REPO}/releases/download/desktop-v{manifest["version"]}/{name}')
        require(entry['url'] == expected, 'Untrusted or mutable package URL')
        result[platform] = name
    return result


def project(manifest):
    names = package_names(manifest, origin='github')
    result = {**manifest, 'platforms': {p: {**manifest['platforms'][p],
        'url': f'{ORIGIN}/downloads/releases/{manifest["version"]}/{name}'} for p, name in names.items()}}
    package_names(result, origin='engine')
    return result


def compare(current, target):
    require(version(target['version']) >= version(current['version']), 'Refusing website downgrade')
    require(set(current['platforms']) <= set(target['platforms']), 'Refusing platform removal')
    require(current.get('macos_distribution') == target.get('macos_distribution'), 'Mac signing policy migration requires explicit receiver acceptance')
    if version(target['version']) == version(current['version']):
        require(current == target, 'Same version has different manifest; inspect, never overwrite')
        return False
    return True


def curl_public(url, output, limit, *, head=False):
    require(url.startswith(ORIGIN + '/'), 'Only the fixed Engine HTTPS origin is allowed')
    # curl works with the deployed XS TLS stack, including on macOS where the
    # system Python OpenSSL client currently receives TLS alert decode_error.
    # No redirects, credentials, curlrc, source URLs or downgrade to HTTP.
    # TLS alert/EOF failures (curl 35) are not retried by --retry alone. These
    # are bounded retries of idempotent public GET/HEAD, NEVER the SSH write.
    command = ['curl', '-q', '--proto', '=https', '--fail', '--silent', '--show-error',
        '--connect-timeout', '20', '--max-time', '300', '--retry', '2', '--retry-delay', '2',
        '--retry-all-errors',
        '--max-filesize', str(limit), '-H', 'Accept-Encoding: identity',
        '-H', 'Cache-Control: no-cache', '--output', str(output), '--write-out', '%{http_code}']
    if head:
        command += ['--head']
    result = subprocess.run([*command, url], check=True, capture_output=True, text=True, timeout=930)
    require(result.stdout == '200', 'Public file is unavailable or redirected')
    require(output.is_file() and output.stat().st_size <= limit, 'Public file exceeds limit')


def public_get(url, limit=MAX_METADATA, *, expected_size=None):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'public-file'
        curl_public(url, path, limit)
        if expected_size is not None:
            require(path.stat().st_size == expected_size, 'Truncated public file')
        return path.read_bytes()


def public_digest(url, size):
    # Installer read-back is bounded on disk, never buffered wholly in RAM.
    require(url.startswith(ORIGIN + '/downloads/releases/'), 'Invalid public package path')
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'installer'
        curl_public(url, path, size)
        require(path.stat().st_size == size, 'Truncated public installer')
        return sha(path)


def public_head(url, size):
    headers = public_get_head(url)
    lengths = re.findall(r'^Content-Length: ([0-9]+)\r?$', headers, re.IGNORECASE | re.MULTILINE)
    require(len(lengths) == 1 and int(lengths[0]) == size, 'Published installer missing or wrong size')


def public_get_head(url):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'headers'
        curl_public(url, path, MAX_METADATA, head=True)
        return path.read_text(encoding='iso-8859-1')


def verify_key(path):
    require(contract.public_key(path)[1] == KEY_HASH, 'Installed updater trust differs')


def live_state():
    data = public_get(ORIGIN + '/updates/stable/latest.json')
    manifest = decode(data)
    digest = hashlib.sha256(data).hexdigest()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / 'latest.json').write_bytes(data)
        (root / 'updater.pub').write_bytes(public_get(ORIGIN + '/updates/stable/updater.pub'))
        verify_key(root / 'updater.pub')
        if digest == BOOTSTRAP_HASH:
            require(manifest['version'] == '0.2.32', 'Bootstrap anchor version differs')
            package_names(manifest, origin='github')
        else:
            package_names(manifest, origin='engine')
            (root / 'latest.json.sig').write_bytes(public_get(ORIGIN + '/updates/stable/latest.json.sig'))
            contract.verify_package(root / 'latest.json', root / 'latest.json.sig', root / 'updater.pub')
    return manifest, digest


def selected_release(release):
    require(release.get('draft') is False and release.get('prerelease') is False and release.get('published_at'), 'Formal published stable release required')
    tag = release.get('tag_name', '')
    require(tag.startswith('desktop-v'), 'Latest public release is not a desktop stable release')
    version(tag.removeprefix('desktop-v'))
    return build.snapshot(release)


def latest():
    release = build.api(f'repos/{REPO}/releases/latest')
    selected_release(release)
    return release


def inventory(text):
    require(len(text) <= MAX_METADATA, 'Oversized checksum inventory')
    result = {}
    for line in text.splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9_.+-]*)', line)
        require(match is not None and match[2] not in result and match[2] != 'SHA256SUMS', 'Unsafe or duplicate checksum inventory')
        result[match[2]] = match[1]
    require(bool(result), 'Empty checksum inventory')
    require(text == ''.join(f'{result[n]}  {n}\n' for n in sorted(result)), 'Noncanonical checksum inventory')
    return result


def check_assets(snapshot, names, *, metadata=False):
    assets = {a['name']: a for a in snapshot['assets']}
    require(names <= set(assets), 'Release is missing required assets')
    for name in names:
        contract.safe_name(name)
        asset = assets[name]
        require(type(asset['size']) is int and 0 < asset['size'] <= (MAX_METADATA if metadata else MAX_TOTAL), 'Invalid asset size')
    require(sum(assets[n]['size'] for n in names) <= MAX_TOTAL, 'Release download quota exceeded')
    return assets


def verify_downloads(root, names, assets, sums):
    for name in names:
        path = root / name
        contract.regular_file(path)
        require(path.stat().st_size == assets[name]['size'], 'Release asset size differs')
        digest = sha(path)
        if name != 'SHA256SUMS':
            require(name in sums and digest == sums[name], 'Source release checksum differs')
        advertised = assets[name].get('digest')
        require(advertised is None or advertised == f'sha256:{digest}', 'GitHub asset digest differs')


def validate_proof(proof, release_snapshot, evidence):
    published = load(proof / 'published.json')
    promotion = load(proof / 'promotion.json')
    result = load(proof / 'publication-result.json')
    require(published == release_snapshot, 'Published release changed since native acceptance')
    require(promotion.get('schema_version') == 1 and promotion.get('status') == 'promotion-authorized'
            and promotion.get('plan') == evidence['plan']
            and promotion.get('manifest_sha256') == evidence['manifest_sha256']
            and promotion.get('public_key_sha256') == KEY_HASH, 'Missing matching native-authorized promotion')
    platforms = set(contract.release_platforms(evidence['plan']))
    require(set(promotion.get('acceptance_sha256', {})) == platforms, 'Missing native platform acceptance')
    for value in promotion['acceptance_sha256'].values():
        contract.digest(value)
    require(result.get('state') == 'published_and_verified' and result.get('release_id') == release_snapshot['id']
            and result.get('public', {}).get('sha256', {}).get('latest.json') == evidence['manifest_sha256'], 'Publication was not verified')
    return promotion


def promotion_proof(audit, snapshot, evidence):
    # Only authenticated, successful current-attempt promotion artifacts count.
    # Candidate release-evidence.json alone explicitly does NOT count.
    runs = build.api(f'repos/{REPO}/actions/workflows/desktop-promote.yml/runs?status=success&per_page=100')['workflow_runs']
    for candidate in runs:
        if candidate.get('head_sha') != evidence['plan']['sha'] or candidate.get('event') != 'workflow_dispatch':
            continue
        run_data = build.successful_run(REPO, candidate['id'], evidence['plan']['sha'], PROMOTE_PATH, event='workflow_dispatch')
        proof = audit / f'promotion-{candidate["id"]}'
        artifact = build.download_artifact(REPO, run_data, 'desktop-promotion-evidence', proof)
        published = load(proof / 'published.json')
        if published.get('id') != snapshot['id']:
            continue
        promotion = validate_proof(proof, snapshot, evidence)
        provenance = load(proof / 'provenance.json')
        require(set(provenance) == {'release', 'unix', 'windows'}, 'Missing workflow provenance')
        for group, recorded in provenance.items():
            previous = recorded['run']
            path = ('.github/workflows/desktop-release.yml' if group == 'release' else build.ACCEPTANCE_WORKFLOWS[group])
            current = build.successful_run(REPO, previous['id'], evidence['plan']['sha'], path,
                event=None if group == 'release' else 'workflow_dispatch',
                unix_platforms=[p for p in contract.release_platforms(evidence['plan']) if p != 'windows-x86_64'] if group == 'unix' else None)
            require(all(current[k] == previous[k] for k in ['id', 'run_attempt', 'updated_at', 'head_sha']), 'Acceptance rerun changed after promotion')
            if group == 'release':
                require(str(current['id']) == evidence['plan']['release_run_id']
                        and str(current['run_attempt']) == evidence['plan']['release_run_attempt'], 'Different candidate build attempt')
        return {'run_id': candidate['id'], 'run_attempt': run_data['run_attempt'], 'artifact': artifact,
                'native_acceptance_sha256': promotion['acceptance_sha256']}
    raise ValueError('No successful native-authorized publication proof for the selected release')


def catalog_check(target, assets, sums, *, payloads=False):
    catalog = decode(public_get(ORIGIN + '/downloads/catalog.json'))
    expected = {'schema_version': 1, 'version': target['version'], 'pub_date': target['pub_date'], 'files': [
        {'platform': p, 'url': target['platforms'][p]['url'], 'size': assets[n]['size'], 'sha256': sums[n]}
        for p, n in sorted(package_names(target, origin='engine').items())]}
    if 'macos_distribution' in target:
        expected['macos_distribution'] = target['macos_distribution']
    require(catalog == expected, 'Website catalog differs from the accepted release')
    for entry in catalog['files']:
        if payloads:
            require(public_digest(entry['url'], entry['size']) == entry['sha256'], 'Published installer bytes differ')
        else:
            public_head(entry['url'], entry['size'])


def fetch_notices(plan, dest):
    for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
        value = build.api(f'repos/{REPO}/contents/{name}?ref={plan["sha"]}')
        require(value.get('type') == 'file' and value.get('encoding') == 'base64' and 0 < value['size'] <= MAX_METADATA, 'Invalid pinned source notice')
        data = base64.b64decode(value['content'], validate=False)
        require(len(data) == value['size'] and hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == value['sha'], 'Pinned notice blob differs')
        (dest / name).write_bytes(data)


def source_still_current(snapshot):
    require(selected_release(latest()) == snapshot, 'GitHub latest release changed; start a fresh sync')


def prepare(work):
    work = contract.new_directory(work)
    audit = work / 'audit'; audit.mkdir()
    release = latest(); snapshot = selected_release(release)
    write(audit / 'source-snapshot.json', snapshot)
    metadata = {'latest.json', 'updater.pub', 'release-evidence.json', 'SHA256SUMS'}
    assets = check_assets(snapshot, metadata, metadata=True)
    source = work / 'source'
    build.download_release(REPO, snapshot['tag_name'], source, sorted(metadata))
    sums = inventory((source / 'SHA256SUMS').read_text(encoding='ascii'))
    verify_downloads(source, metadata, assets, sums)
    shutil.copyfile(source / 'SHA256SUMS', audit / 'source-SHA256SUMS')
    verify_key(source / 'updater.pub')
    evidence = load(source / 'release-evidence.json'); plan = evidence['plan']
    contract.validate_plan(plan)
    require(plan['repository'] == REPO and plan['tag'] == snapshot['tag_name']
            and plan['sha'] == snapshot['target_commitish'], 'Release source differs from the immutable plan')
    names = contract.release_names(plan)
    require(set(assets) == names | ({'windows-debug-symbols.zip'} if 'windows-debug-symbols.zip' in assets else set()), 'Unexpected release asset inventory')
    require(set(sums) == set(assets) - {'SHA256SUMS'}, 'Original checksum inventory does not bind every release asset')
    target = project(load(source / 'latest.json'))
    require(target['version'] == plan['version'], 'Plan/manifest version mismatch')
    require(evidence.get('manifest_sha256') == sha(source / 'latest.json') and evidence.get('public_key_sha256') == KEY_HASH, 'Release evidence binding differs')
    current, baseline = live_state()
    needed = compare(current, target)
    receipt = {'schema_version': 1, 'version': target['version'], 'baseline_sha256': baseline,
        'manifest_sha256': hashlib.sha256(encoded(target)).hexdigest(), 'source_snapshot': snapshot,
        'source_inventory': sums, 'target': target, 'sync_needed': needed,
        'excluded_assets': ['windows-debug-symbols.zip'] if 'windows-debug-symbols.zip' in assets else []}
    if not needed:
        catalog_check(target, assets, sums)
        source_still_current(snapshot)
        receipt['state'] = 'already-current-metadata-verified'
        write(audit / 'prepare.json', receipt)
        return receipt
    receipt['promotion'] = promotion_proof(audit, snapshot, evidence)
    remaining = names - metadata
    check_assets(snapshot, names)
    check_assets(snapshot, {n for n in remaining if n.endswith(('.json', '.sig'))}, metadata=True)
    extra = work / 'packages'
    build.download_release(REPO, snapshot['tag_name'], extra, sorted(remaining))
    verify_downloads(extra, remaining, assets, sums)
    for path in extra.iterdir():
        shutil.move(path, source / path.name)
    extra.rmdir()
    # Original inventory includes intentionally unmirrored debug symbols. All
    # selected bytes were checked against it above; validate this projection with
    # the unchanged public release contract (no weakening its inventory rule).
    (source / 'SHA256SUMS').write_text(contract.checksums(source), encoding='ascii')
    contract.validate_release(plan, source, source / 'updater.pub')
    export = work / 'export'; export.mkdir()
    for name in {'updater.pub'} | {n for p in target['platforms'] for n in
            [contract.package_name(plan, p), contract.package_name(plan, p) + '.sig']}:
        shutil.copyfile(source / name, export / name)
    write(export / 'latest.json', target)
    write(export / 'release.json', {'schema_version': 1, 'version': target['version'], 'notes': target['notes'],
        'pub_date': target['pub_date'], 'public_key_sha256': KEY_HASH, 'manifest_sha256': receipt['manifest_sha256'],
        'platforms': sorted(target['platforms'])})
    fetch_notices(plan, export)
    source_still_current(snapshot)
    require(live_state()[1] == baseline, 'Website feed changed during preparation')
    receipt['state'] = 'prepared-unsigned-not-published'
    receipt['export_inventory'] = {p.name: sha(p) for p in export.iterdir()}
    write(audit / 'prepare.json', receipt)
    return receipt


def export_files(work):
    receipt = load(work / 'audit/prepare.json')
    require(receipt.get('sync_needed') is True, 'No new publication prepared')
    export = work / 'export'
    require(export.is_dir() and not export.is_symlink(), 'Unsafe export')
    expected = set(receipt['export_inventory']) | {'latest.json.sig', 'SHA256SUMS'}
    require(len(expected) <= 20 and {p.name for p in export.iterdir()} == expected, 'Unexpected export members')
    files = {}
    for path in export.iterdir():
        contract.regular_file(path); contract.safe_name(path.name)
        files[path.name] = path
    require(sum(p.stat().st_size for p in files.values()) <= MAX_TOTAL, 'Export quota exceeded')
    require(all(sha(files[n]) == value for n, value in receipt['export_inventory'].items()), 'Prepared export bytes changed')
    verify_key(export / 'updater.pub')
    require((export / 'SHA256SUMS').read_text(encoding='ascii') == contract.checksums(export), 'Export inventory differs')
    manifest = load(export / 'latest.json')
    names = package_names(manifest, origin='engine')
    require(manifest == receipt['target'] and sha(export / 'latest.json') == receipt['manifest_sha256'], 'Export manifest differs')
    for name in ['latest.json', *names.values()]:
        contract.verify_package(export / name, export / (name + '.sig'), export / 'updater.pub')
    return receipt, files


def seal(work):
    # Caller uses the stable Tauri signer ONLY after prepare has passed. The
    # detached feed signature is checked here before making a flat upload.
    export = work / 'export'
    require(not (export / 'SHA256SUMS').exists(), 'Already sealed; never overwrite')
    (export / 'SHA256SUMS').write_text(contract.checksums(export), encoding='ascii')
    receipt, files = export_files(work)
    archive = work / 'upload.tar'
    with tarfile.open(archive, 'x', format=tarfile.USTAR_FORMAT) as stream:
        for name, path in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size = path.stat().st_size; info.mode = 0o444; info.mtime = 0
            with path.open('rb') as payload:
                stream.addfile(info, payload)
    result = {'state': 'sealed-not-published', 'archive_sha256': sha(archive), 'version': receipt['version']}
    write(work / 'audit/bundle.json', result)
    return result


def smoke(work):
    receipt = load(work / 'audit/prepare.json')
    current, digest = live_state()
    require(current == receipt['target'] and digest == receipt['manifest_sha256'], 'Public updater feed is not the expected projection')
    assets = {a['name']: a for a in receipt['source_snapshot']['assets']}
    catalog_check(current, assets, receipt['source_inventory'], payloads=True)
    # Verify public metadata/notices/signatures, not only the four installer URLs.
    _, files = export_files(work)
    for name, path in files.items():
        actual = public_get(f'{ORIGIN}/downloads/releases/{current["version"]}/{name}',
            limit=MAX_METADATA) if name not in package_names(current, origin='engine').values() else None
        if actual is not None:
            require(hashlib.sha256(actual).hexdigest() == sha(path), 'Published public export metadata differs')
    result = {'state': 'published-https-payloads-verified', 'version': current['version'], 'manifest_sha256': digest,
              'platforms': sorted(current['platforms'])}
    write(work / 'audit/smoke.json', result)
    return result


def ssh_arguments(key, known_hosts):
    for path in [key, known_hosts]:
        contract.regular_file(path)
        require(path.stat().st_size > 0, 'Missing dedicated publication SSH credentials')
    return ['ssh', '-F', '/dev/null', '-i', str(key), '-p', '22', '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={known_hosts}',
        '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', 'xs@222.186.10.53']


def publish(work, key, known_hosts):
    receipt, _ = export_files(work)
    bundle = load(work / 'audit/bundle.json')
    require(sha(work / 'upload.tar') == bundle['archive_sha256'], 'Sealed upload changed')
    source_still_current(receipt['source_snapshot'])
    current, digest = live_state()
    if digest == receipt['manifest_sha256']:
        # Previous attempt may have succeeded before the client lost its reply.
        return smoke(work)
    require(digest == receipt['baseline_sha256'] and compare(current, receipt['target']), 'Publication baseline changed; do not retry blindly')
    command = f'publish v1 {digest} {bundle["archive_sha256"]}'
    attempt = {'state': 'publication-attempted', 'version': receipt['version'], 'baseline_sha256': digest,
               'archive_sha256': bundle['archive_sha256']}
    write(work / 'audit/publication-attempt.json', attempt)
    error = None
    try:
        with (work / 'upload.tar').open('rb') as payload:
            subprocess.run([*ssh_arguments(key, known_hosts), command], stdin=payload, check=True, timeout=1200)
    except (OSError, subprocess.SubprocessError) as caught:
        error = type(caught).__name__
    # No automatic SSH resend: read back the authoritative public state first.
    for attempt_number in range(3):
        try:
            result = smoke(work)
            if error:
                result['ssh_reply'] = 'unknown-but-publication-independently-verified'
                write(work / 'audit/smoke.json', result)
            return result
        except (ValueError, OSError, subprocess.SubprocessError) as caught:
            if attempt_number == 2:
                write(work / 'audit/publication-result.json', {'state': 'outcome-unverified-inspect-before-retry',
                    'version': receipt['version'], 'ssh_error_kind': error, 'smoke_error_kind': type(caught).__name__})
                raise ValueError('Publication outcome unverified; inspect public feed and server staging before retrying') from caught
            time.sleep(5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'seal', 'publish', 'smoke'])
    parser.add_argument('--work', required=True, type=Path)
    parser.add_argument('--ssh-key', type=Path)
    parser.add_argument('--known-hosts', type=Path)
    args = parser.parse_args()
    if args.command == 'prepare':
        result = prepare(args.work)
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                output.write(f'sync_needed={str(result["sync_needed"]).lower()}\nversion={result["version"]}\n')
        result = {k: result[k] for k in ['state', 'version', 'sync_needed', 'excluded_assets']}
    elif args.command == 'seal':
        result = seal(args.work)
    elif args.command == 'smoke':
        result = smoke(args.work)
    else:
        require(args.ssh_key is not None and args.known_hosts is not None, 'Dedicated SSH key and pinned host keys required')
        result = publish(args.work, args.ssh_key, args.known_hosts)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f'Engine release sync failed ({type(error).__name__}): {error}', file=sys.stderr)
        sys.exit(2)
