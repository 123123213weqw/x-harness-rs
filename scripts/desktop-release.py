#!/usr/bin/env python3
"""Fail-closed, public-material-only contract for the unified desktop channel.

Build jobs only produce receipts. One aggregator creates the complete manifest;
publication remains a separate, native-acceptance-gated workflow operation.
This module never reads signing private keys and never compiles Rust.
"""
import argparse
import base64
import binascii
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('friends_contract', ROOT / 'scripts/friends-release.py')
_friends = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_friends)
version = _friends.version
validate_repository = _friends.validate_repository

PREFIX = 'desktop-v'
IDENTIFIER = 'com.xlang.xharness'
PLATFORMS = {
    'windows-x86_64': ('x86_64-pc-windows-msvc', 'XHarness_{version}_x64-setup.exe'),
    'darwin-aarch64': ('aarch64-apple-darwin', 'XHarness_{version}_aarch64.app.tar.gz'),
    'darwin-x86_64': ('x86_64-apple-darwin', 'XHarness_{version}_x86_64.app.tar.gz'),
    'linux-x86_64-appimage': ('x86_64-unknown-linux-gnu', 'XHarness_{version}_amd64.AppImage'),
}
# Deliberately NO linux-x86_64 fallback: Tauri deb/rpm clients also fall back to
# that key, and must never receive an AppImage as their native package update.
MANIFEST_NOTES = 'Signed unified desktop update. Save work before restarting.'
PLAN_FIELDS = {'schema_version', 'repository', 'tag', 'version', 'sha', 'endpoint',
               'release_run_id', 'release_run_attempt', 'ci'}
CI_FIELDS = {'id', 'run_attempt', 'head_sha', 'head_branch', 'event', 'status', 'conclusion', 'path'}
RECEIPT_FIELDS = (PLAN_FIELDS - {'endpoint'}) | {
    'platform', 'target', 'package', 'package_sha256', 'package_size', 'signature',
    'public_key_sha256', 'binary_sha256', 'embedded_endpoint', 'identifier'}
UNIX_CHECKS = {'signatureVerified', 'unavailableFeedRejected', 'concurrentCheckRejected',
               'tamperedPackageRejected', 'unconfirmedInstallRejected', 'exactCandidateInstalled',
               'restartVerified', 'dataPreserved', 'persistedSessionRestored', 'nativeLaunchVerified'}
PLATFORM_CHECKS = {
    'windows-x86_64': {'signature', 'install', 'launch', 'update', 'state-preservation',
                       'embedded-channel', 'corrupt-package-rejected', 'confirmation-required'},
    'darwin-aarch64': UNIX_CHECKS | {'codesignVerified', 'gatekeeperAccepted', 'notarizationStapleVerified'},
    'darwin-x86_64': UNIX_CHECKS | {'codesignVerified', 'gatekeeperAccepted', 'notarizationStapleVerified'},
    'linux-x86_64-appimage': UNIX_CHECKS,
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(value, expected, label):
    require(isinstance(value, dict) and set(value) == expected, f'Unexpected {label} schema')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f'Duplicate JSON key: {key}')
        result[key] = value
    return result


def read_json(path):
    regular_file(Path(path))
    return json.loads(Path(path).read_text(encoding='utf-8-sig'), object_pairs_hook=unique_object)


def write_json(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write('\n')


def regular_file(path):
    require(not path.is_symlink() and path.is_file(), f'Missing or unsafe regular file: {path.name}')


def safe_name(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value)
            and value not in {'.', '..'}, 'Unsafe asset name')
    return value


def exact_tree(root, expected):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), f'Missing or unsafe directory: {root}')
    actual = set()
    for child in root.iterdir():
        safe_name(child.name)
        regular_file(child)
        actual.add(child.name)
    require(actual == set(expected), f'Unexpected, missing, or secret files in {root.name}: {sorted(actual ^ set(expected))}')


def new_directory(path):
    path = Path(path)
    require(not path.exists() and not path.is_symlink(), f'Output already exists; never overwrite: {path}')
    path.mkdir(parents=True)
    return path


def sha256(path):
    regular_file(Path(path))
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def digest(value):
    require(isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value), 'Invalid SHA256')
    return value


def public_key(path):
    regular_file(Path(path))
    text = Path(path).read_text(encoding='utf-8-sig').strip()
    try:
        lines = base64.b64decode(text, validate=True).decode('utf-8').strip().splitlines()
        require(len(lines) == 2 and lines[0].startswith('untrusted comment: '), 'Invalid updater public key')
        packet = base64.b64decode(lines[1], validate=True)
        require(len(packet) == 42 and packet[:2] == b'Ed', 'Invalid updater public key packet')
    except (ValueError, UnicodeError, binascii.Error) as error:
        raise ValueError('Invalid updater public key') from error
    return text, hashlib.sha256(packet).hexdigest()


def verify_package(package, signature_path, public_key_path):
    regular_file(Path(package))
    regular_file(Path(signature_path))
    require(Path(package).stat().st_size > 0, 'Empty updater package')
    public_key(public_key_path)
    signature = Path(signature_path).read_text(encoding='utf-8-sig').strip()
    require(0 < len(signature) < 8192, 'Missing or oversized signature')
    try:
        lines = base64.b64decode(signature, validate=True).decode('utf-8').strip().splitlines()
        require(len(lines) == 4, 'Invalid signature envelope')
    except (ValueError, UnicodeError, binascii.Error) as error:
        raise ValueError('Invalid signature envelope') from error
    try:
        subprocess.run(['node', str(ROOT / 'scripts/verify-updater-package.mjs'),
                        str(package), str(signature_path), str(public_key_path)],
                       check=True, capture_output=True, text=True, encoding='utf-8')
    except subprocess.CalledProcessError as error:
        raise ValueError('Independent updater signature verification failed') from error
    return signature


def endpoint(repository):
    return f'https://github.com/{repository}/releases/latest/download/latest.json'


def validate_ci(ci, sha):
    fields(ci, CI_FIELDS, 'CI')
    require(type(ci['id']) is int and ci['id'] > 0 and type(ci['run_attempt']) is int
            and ci['run_attempt'] > 0, 'Invalid CI identity')
    require(ci['head_sha'] == sha and ci['head_branch'] == 'master' and ci['event'] == 'push'
            and ci['status'] == 'completed' and ci['conclusion'] == 'success'
            and ci['path'] == '.github/workflows/ci.yml', 'Require successful exact-SHA master push CI')


def select_ci(runs, sha):
    candidates = [run for run in runs if run.get('head_sha') == sha
                  and run.get('event') == 'push' and run.get('head_branch') == 'master']
    require(candidates, 'No exact-SHA master push CI run')
    newest = max(candidates, key=lambda run: (int(run['id']), int(run.get('run_attempt', 1))))
    ci = {key: newest.get(key) for key in CI_FIELDS}
    validate_ci(ci, sha)
    return ci


def release_platforms(plan):
    scope = plan.get('release_scope', 'all')
    require(isinstance(scope, str) and scope in {'all', 'windows-linux'}, 'Unknown release scope')
    return tuple(p for p in PLATFORMS if scope == 'all' or not p.startswith('darwin-'))


def validate_plan(plan):
    fields(plan, PLAN_FIELDS | ({'release_scope'} if 'release_scope' in plan else set()), 'plan')
    release_platforms(plan)
    require(type(plan['schema_version']) is int and plan['schema_version'] == 1, 'Unknown schema')
    validate_repository(plan['repository'], plan['repository'])
    version(plan['version'])
    require(plan['tag'] == PREFIX + plan['version'], 'Tag/version mismatch')
    require(isinstance(plan['sha'], str) and re.fullmatch(r'[0-9a-f]{40}', plan['sha']), 'Invalid commit SHA')
    for key in ('release_run_id', 'release_run_attempt'):
        require(isinstance(plan[key], str) and re.fullmatch(r'[1-9][0-9]*', plan[key]), 'Invalid release run identity')
    require(plan['endpoint'] == endpoint(plan['repository']), 'Noncanonical embedded endpoint')
    validate_ci(plan['ci'], plan['sha'])
    return plan


def make_plan(repository, configured_repository, tag, sha, run_id, attempt, releases, runs, release_scope='all'):
    validate_repository(repository, configured_repository)
    require(isinstance(tag, str) and tag.startswith(PREFIX), 'Wrong release tag prefix')
    target = tag[len(PREFIX):]
    target_version = version(target)
    require(not any(row['tagName'] == tag for row in releases), 'Release exists; never overwrite draft or published assets')
    for row in releases:
        old_tag = row['tagName']
        for prefix in ('friends-v', PREFIX):
            if old_tag.startswith(prefix):
                old_version = version(old_tag[len(prefix):])
                require(target_version != old_version, 'Stable version already exists in a draft or published channel release')
                if not row['isDraft']:
                    require(target_version > old_version, 'Version must exceed every published stable channel version')
    return validate_plan({'schema_version': 1, 'repository': repository, 'tag': tag,
                          'version': target, 'sha': sha, 'endpoint': endpoint(repository),
                          'release_run_id': str(run_id), 'release_run_attempt': str(attempt),
                          'ci': select_ci(runs, sha), **({'release_scope': release_scope} if release_scope != 'all' else {})})


def package_name(plan, platform):
    require(platform in release_platforms(plan), 'Unsupported or unselected updater platform')
    return PLATFORMS[platform][1].format(version=plan['version'])


def binary_channel(binary, platform, plan, key):
    regular_file(Path(binary))
    data = Path(binary).read_bytes()
    require(plan['endpoint'].encode() in data, 'Desktop binary lacks the canonical embedded endpoint')
    require(key.encode() in data, 'Desktop binary lacks the expected embedded updater public key')
    if platform == 'windows-x86_64':
        require(len(data) >= 64 and data[:2] == b'MZ', 'Not a PE desktop binary')
        offset = struct.unpack_from('<I', data, 60)[0]
        require(offset + 6 <= len(data) and data[offset:offset + 4] == b'PE\0\0'
                and struct.unpack_from('<H', data, offset + 4)[0] == 0x8664, 'Wrong Windows binary architecture')
    elif platform.startswith('darwin-'):
        require(len(data) >= 8 and data[:4] == b'\xcf\xfa\xed\xfe', 'Require thin 64-bit Mach-O for the declared Mac target')
        expected = 0x100000c if platform == 'darwin-aarch64' else 0x1000007
        require(struct.unpack_from('<I', data, 4)[0] == expected, 'Wrong macOS binary architecture')
    else:
        require(len(data) >= 20 and data[:6] == b'\x7fELF\x02\x01'
                and struct.unpack_from('<H', data, 18)[0] == 62, 'Wrong Linux binary architecture')
    return hashlib.sha256(data).hexdigest()


def create_receipt(plan, platform, target, package, public_key_path, binary, config_path, output):
    validate_plan(plan)
    require(platform in PLATFORMS and target == PLATFORMS[platform][0], 'Platform/target mismatch')
    key, key_hash = public_key(public_key_path)
    config = read_json(config_path)
    require(config.get('version') == plan['version'] and config.get('identifier') == IDENTIFIER,
            'Bundler version/identifier mismatch')
    require(config.get('plugins', {}).get('updater', {}).get('pubkey', '').strip() == key,
            'Bundler updater key mismatch')
    binary_hash = binary_channel(binary, platform, plan, key)
    package = Path(package)
    signature_path = Path(str(package) + '.sig')
    signature = verify_package(package, signature_path, public_key_path)
    name = package_name(plan, platform)
    result = {key: value for key, value in plan.items() if key != 'endpoint'}
    result.update(platform=platform, target=target, package=name, package_sha256=sha256(package),
                  package_size=package.stat().st_size, signature=signature, public_key_sha256=key_hash,
                  binary_sha256=binary_hash, embedded_endpoint=plan['endpoint'], identifier=IDENTIFIER)
    dest = new_directory(output)
    shutil.copyfile(package, dest / name)
    (dest / (name + '.sig')).write_text(signature + '\n', encoding='utf-8')
    (dest / 'updater.pub').write_text(key + '\n', encoding='utf-8')
    write_json(dest / 'receipt.json', result)
    return result


def validate_receipt(plan, platform, root, expected_public_key, *, receipt_name='receipt.json', strict_tree=True):
    validate_plan(plan)
    name = package_name(plan, platform)
    root = Path(root)
    if strict_tree:
        exact_tree(root, {name, name + '.sig', 'updater.pub', receipt_name})
    receipt = read_json(root / receipt_name)
    fields(receipt, RECEIPT_FIELDS | ({'release_scope'} if 'release_scope' in plan else set()), 'receipt')
    require(type(receipt['schema_version']) is int and receipt['schema_version'] == 1, 'Unknown receipt schema')
    validate_ci(receipt['ci'], plan['sha'])
    for key, value in plan.items():
        if key != 'endpoint':
            require(receipt[key] == value, f'Receipt disagrees with plan: {key}')
    require(receipt['platform'] == platform and receipt['target'] == PLATFORMS[platform][0], 'Receipt platform/target mismatch')
    require(receipt['package'] == name and receipt['identifier'] == IDENTIFIER, 'Receipt package/identifier mismatch')
    require(receipt['embedded_endpoint'] == plan['endpoint'], 'Receipt embedded endpoint mismatch')
    digest(receipt['binary_sha256'])
    _, expected_hash = public_key(expected_public_key)
    _, actual_hash = public_key(root / 'updater.pub')
    require(receipt['public_key_sha256'] == expected_hash == actual_hash, 'Updater trust key changed')
    require(type(receipt['package_size']) is int and receipt['package_size'] > 0
            and receipt['package_size'] == (root / name).stat().st_size, 'Package size mismatch')
    require(digest(receipt['package_sha256']) == sha256(root / name), 'Package hash mismatch')
    require(receipt['signature'] == verify_package(root / name, root / (name + '.sig'), expected_public_key),
            'Receipt signature mismatch')
    return receipt


def release_names(plan):
    names = {'latest.json', 'SHA256SUMS', 'release-evidence.json', 'updater.pub'}
    for platform in release_platforms(plan):
        name = package_name(plan, platform)
        names.update({name, name + '.sig', platform + '.receipt.json'})
    return names


def checksums(root):
    # Path ordering is case-insensitive on Windows. Keep the Linux-produced
    # inventory byte-for-byte deterministic when verifying on another OS.
    return ''.join(f'{sha256(path)}  {path.name}\n'
                   for path in sorted(Path(root).iterdir(), key=lambda path: path.name)
                   if path.name != 'SHA256SUMS')


def assemble(plan, artifacts, public_key_path, output):
    validate_plan(plan)
    artifacts = Path(artifacts)
    require(artifacts.is_dir() and not artifacts.is_symlink(), 'Unsafe artifacts root')
    require({path.name for path in artifacts.iterdir()} == set(release_platforms(plan)), 'Require exactly selected platform artifact directories')
    receipts = {platform: validate_receipt(plan, platform, artifacts / platform, public_key_path) for platform in release_platforms(plan)}
    dest = new_directory(output)
    key, key_hash = public_key(public_key_path)
    (dest / 'updater.pub').write_text(key + '\n', encoding='utf-8')
    entries = {}
    for platform, receipt in receipts.items():
        source = artifacts / platform
        name = receipt['package']
        shutil.copyfile(source / name, dest / name)
        shutil.copyfile(source / (name + '.sig'), dest / (name + '.sig'))
        write_json(dest / (platform + '.receipt.json'), receipt)
        entries[platform] = {'signature': receipt['signature'],
                             'url': f'https://github.com/{plan["repository"]}/releases/download/{plan["tag"]}/{name}'}
    manifest = {'version': plan['version'], 'notes': MANIFEST_NOTES,
                'pub_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'platforms': entries}
    write_json(dest / 'latest.json', manifest)
    evidence = {'schema_version': 1, 'plan': plan, 'public_key_sha256': key_hash,
                'manifest_sha256': sha256(dest / 'latest.json'),
                'receipts': {platform: sha256(dest / (platform + '.receipt.json')) for platform in release_platforms(plan)},
                'status': 'candidate-verified-not-native-accepted'}
    write_json(dest / 'release-evidence.json', evidence)
    (dest / 'SHA256SUMS').write_text(checksums(dest), encoding='ascii', newline='\n')
    return evidence


def validate_release(plan, root, public_key_path):
    validate_plan(plan)
    root = Path(root)
    exact_tree(root, release_names(plan))
    require((root / 'SHA256SUMS').read_text(encoding='ascii') == checksums(root), 'Release checksum inventory mismatch')
    evidence = read_json(root / 'release-evidence.json')
    fields(evidence, {'schema_version', 'plan', 'public_key_sha256', 'manifest_sha256', 'receipts', 'status'}, 'release evidence')
    require(type(evidence['schema_version']) is int and evidence['schema_version'] == 1 and evidence['plan'] == plan
            and evidence['status'] == 'candidate-verified-not-native-accepted', 'Release evidence identity mismatch')
    key, key_hash = public_key(public_key_path)
    require(public_key(root / 'updater.pub')[1] == evidence['public_key_sha256'] == key_hash, 'Release trust key mismatch')
    require(evidence['manifest_sha256'] == sha256(root / 'latest.json'), 'Manifest hash mismatch')
    require(set(evidence['receipts']) == set(release_platforms(plan)), 'Incomplete release receipt evidence')
    manifest = read_json(root / 'latest.json')
    fields(manifest, {'version', 'notes', 'pub_date', 'platforms'}, 'manifest')
    require(manifest['version'] == plan['version'], 'Manifest version mismatch')
    require(manifest['notes'] == MANIFEST_NOTES and isinstance(manifest['pub_date'], str)
            and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', manifest['pub_date']), 'Unexpected manifest metadata')
    datetime.datetime.strptime(manifest['pub_date'], '%Y-%m-%dT%H:%M:%SZ')
    require(set(manifest['platforms']) == set(release_platforms(plan)), 'Manifest platform set incomplete or unexpected')
    for platform in release_platforms(plan):
        name = package_name(plan, platform)
        expected_url = f'https://github.com/{plan["repository"]}/releases/download/{plan["tag"]}/{name}'
        entry = manifest['platforms'][platform]
        fields(entry, {'url', 'signature'}, 'manifest platform')
        require(entry['url'] == expected_url, 'Mutable, external, or wrong-version package URL')
        receipt_path = root / (platform + '.receipt.json')
        require(evidence['receipts'][platform] == sha256(receipt_path), 'Receipt evidence hash mismatch')
        receipt = validate_receipt(plan, platform, root, public_key_path,
                                   receipt_name=platform + '.receipt.json', strict_tree=False)
        require(entry['signature'] == receipt['signature'], 'Manifest signature mismatch')
    return manifest, evidence


def validate_live(plan, live_root, candidate_manifest, public_key_path):
    root = Path(live_root)
    require(root.is_dir() and not root.is_symlink(), 'Unsafe live snapshot')
    live = read_json(root / 'latest.json')
    require(isinstance(live, dict) and {'version', 'platforms'} <= set(live), 'Invalid live manifest')
    require(version(live['version']) < version(plan['version']), 'Candidate must be newer than current live version')
    require(isinstance(live['platforms'], dict) and 'windows-x86_64' in live['platforms'], 'Current live Windows channel missing')
    require(set(live['platforms']) <= set(candidate_manifest['platforms']), 'Promotion would drop a live updater platform')
    require(public_key(root / 'updater.pub')[1] == public_key(public_key_path)[1], 'Current live updater trust key differs')
    expected = {'latest.json', 'updater.pub'}
    urls = {}
    for platform, entry in live['platforms'].items():
        require(isinstance(entry, dict) and {'url', 'signature'} <= set(entry), 'Invalid live platform')
        url = urlsplit(entry['url'])
        parts = url.path.split('/')
        require(url.scheme == 'https' and url.netloc == 'github.com' and not url.query and not url.fragment
                and len(parts) == 7 and '/'.join(parts[1:3]) == plan['repository']
                and parts[3:5] == ['releases', 'download'], 'Untrusted live package URL')
        tag, name = parts[5:]
        safe_name(name)
        require(tag in {'friends-v' + live['version'], PREFIX + live['version']}, 'Live package tag/version mismatch')
        require(name == PLATFORMS[platform][1].format(version=live['version']), 'Live package name/platform/version mismatch')
        require(name not in urls, 'Duplicate live platform assets')
        urls[name] = entry
        expected.update({name, name + '.sig'})
    exact_tree(root, expected)
    for name, entry in urls.items():
        signature = verify_package(root / name, root / (name + '.sig'), public_key_path)
        require(signature == entry['signature'], 'Live manifest signature mismatch')
    return live


def validate_acceptance(plan, root, release_root, manifest_hash):
    root, release_root = Path(root), Path(release_root)
    require(root.is_dir() and not root.is_symlink(), 'Missing native acceptance directory')
    require({path.name for path in root.iterdir()} == set(release_platforms(plan)), 'Require native acceptance from all selected platforms')
    results = {}
    for platform in release_platforms(plan):
        directory = root / platform
        exact_tree(directory, {'acceptance.json'})
        value = read_json(directory / 'acceptance.json')
        fields(value, {'schema_version', 'platform', 'version', 'sha', 'release_run_id', 'release_run_attempt',
                       'manifest_sha256', 'package_sha256', 'status', 'nativeUpdateAccepted', 'checks',
                       'scope', 'baseInstrumented', 'base_version', 'provenance'}, 'native acceptance')
        require(type(value['schema_version']) is int and value['schema_version'] == 1, 'Unknown acceptance schema')
        for key in ('version', 'sha', 'release_run_id', 'release_run_attempt'):
            require(value[key] == plan[key], f'Acceptance from different release: {key}')
        require(value['platform'] == platform and value['status'] == 'passed'
                and value['nativeUpdateAccepted'] is True, 'Real native update acceptance has not passed')
        require(version(value['base_version']) < version(plan['version']), 'Acceptance must upgrade from a lower base version')
        provenance = value['provenance']
        fields(provenance, {'workflow', 'run_id', 'run_attempt', 'source_sha'}, 'acceptance provenance')
        workflow = 'desktop-windows-update-acceptance.yml' if platform == 'windows-x86_64' else 'desktop-unix-update-acceptance.yml'
        require(provenance['workflow'] == '.github/workflows/' + workflow and provenance['source_sha'] == plan['sha'],
                'Acceptance used another workflow or source SHA')
        for key in ('run_id', 'run_attempt'):
            require(isinstance(provenance[key], str) and re.fullmatch(r'[1-9][0-9]*', provenance[key]),
                    'Invalid acceptance workflow run identity')
        if platform == 'windows-x86_64':
            require(value['scope'] == 'exact-production-candidate' and value['baseInstrumented'] is False,
                    'Windows acceptance must use unmodified production binaries')
        else:
            require(value['scope'] == 'instrumented-base-to-signed-candidate' and value['baseInstrumented'] is True,
                    'Unix acceptance must declare its instrumented-base scope')
        require(value['manifest_sha256'] == manifest_hash, 'Acceptance tested another manifest')
        require(value['package_sha256'] == sha256(release_root / package_name(plan, platform)), 'Acceptance tested another package')
        require(isinstance(value['checks'], dict)
                and set(value['checks']) == PLATFORM_CHECKS[platform]
                and all(check is True for check in value['checks'].values()), 'Required native checks missing or failed')
        results[platform] = sha256(directory / 'acceptance.json')
    return results


def promotion(plan, release_root, acceptance_root, live_root, public_key_path, current_ci):
    require(select_ci(current_ci, plan['sha']) == plan['ci'], 'CI changed or reran after the candidate was planned')
    manifest, evidence = validate_release(plan, release_root, public_key_path)
    live = validate_live(plan, live_root, manifest, public_key_path)
    acceptance = validate_acceptance(plan, acceptance_root, release_root, evidence['manifest_sha256'])
    return {'schema_version': 1, 'status': 'promotion-authorized', 'plan': plan,
            'previous_live_version': live['version'], 'previous_live_manifest_sha256': sha256(Path(live_root) / 'latest.json'),
            'manifest_sha256': evidence['manifest_sha256'], 'public_key_sha256': evidence['public_key_sha256'],
            'acceptance_sha256': acceptance}


def gh_json(*arguments):
    return json.loads(subprocess.check_output(['gh', *arguments], text=True, encoding='utf-8'), object_pairs_hook=unique_object)


def fetch_ci(repository, sha):
    # GitHub's workflow endpoint fixes workflow identity; head SHA and returned
    # path are independently checked. The latest matching run must have passed.
    return gh_json('api', f'repos/{repository}/actions/workflows/ci.yml/runs?head_sha={sha}&per_page=100')['workflow_runs']


def require_environment(plan, building=False):
    validate_repository(os.environ['GITHUB_REPOSITORY'], os.environ.get('XHARNESS_FRIENDS_RELEASE_REPOSITORY', ''))
    require(plan['repository'] == os.environ['GITHUB_REPOSITORY'], 'Plan repository does not match executing workflow')
    checkout = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True, encoding='utf-8').strip()
    require(checkout == plan['sha'], 'Checked-out source differs from release plan')
    if building:
        for environment, key in [('GITHUB_SHA', 'sha'), ('GITHUB_RUN_ID', 'release_run_id'), ('GITHUB_RUN_ATTEMPT', 'release_run_attempt')]:
            require(os.environ.get(environment) == plan[key], f'Build environment mismatch: {environment}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    sub = commands.add_parser('plan')
    sub.add_argument('tag')
    sub.add_argument('--release-scope', choices=['all', 'windows-linux'], default='all')
    sub.add_argument('--output', required=True, type=Path)
    sub = commands.add_parser('receipt')
    for name in ('plan', 'package', 'public-key', 'binary', 'output'):
        sub.add_argument('--' + name, required=True, type=Path)
    sub.add_argument('--config', type=Path, default=ROOT / 'apps/desktop/src-tauri/tauri.conf.json')
    sub.add_argument('--platform', required=True, choices=PLATFORMS)
    sub.add_argument('--target', required=True)
    sub = commands.add_parser('aggregate')
    for name in ('plan', 'artifacts', 'public-key', 'output'):
        sub.add_argument('--' + name, required=True, type=Path)
    sub = commands.add_parser('promotion')
    for name in ('plan', 'release-dir', 'acceptance-root', 'live-dir', 'public-key', 'output'):
        sub.add_argument('--' + name, required=True, type=Path)
    sub = commands.add_parser('verify-release')
    for name in ('plan', 'release-dir', 'public-key'):
        sub.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    if args.command == 'plan':
        repository = os.environ['GITHUB_REPOSITORY']
        plan = make_plan(repository, os.environ.get('XHARNESS_FRIENDS_RELEASE_REPOSITORY', ''), args.tag,
                         os.environ['GITHUB_SHA'], os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'],
                         _friends.releases(repository), fetch_ci(repository, os.environ['GITHUB_SHA']), args.release_scope)
        require_environment(plan, building=True)
        tag_sha = subprocess.check_output(['git', 'rev-parse', args.tag + '^{commit}'], cwd=ROOT, text=True, encoding='utf-8').strip()
        require(tag_sha == plan['sha'], 'Release tag differs from checked-out source')
        write_json(args.output, plan)
        if os.environ.get('GITHUB_ENV'):
            with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as output:
                output.write(f'RELEASE_VERSION={plan["version"]}\nXHARNESS_UPDATER_ENDPOINT={plan["endpoint"]}\n')
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                output.write(f'version={plan["version"]}\nendpoint={plan["endpoint"]}\n')
    else:
        plan = validate_plan(read_json(args.plan))
        require_environment(plan, building=args.command in {'receipt', 'aggregate'})
        if args.command == 'receipt':
            create_receipt(plan, args.platform, args.target, args.package, args.public_key, args.binary, args.config, args.output)
        elif args.command == 'aggregate':
            assemble(plan, args.artifacts, args.public_key, args.output)
        elif args.command == 'verify-release':
            validate_release(plan, args.release_dir, args.public_key)
        else:
            result = promotion(plan, args.release_dir, args.acceptance_root, args.live_dir,
                               args.public_key, fetch_ci(plan['repository'], plan['sha']))
            write_json(args.output, result)


if __name__ == '__main__':
    main()
