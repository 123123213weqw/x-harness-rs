"""Opt-in repository-owned release contract; never reads private material."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PREFIX = 'friends-v'


def validate_repository(repository, configured_repository):
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+', repository)
            or repository.split('/')[-1] in {'.', '..'}):
        raise ValueError('Invalid owner/repository identity')
    if not configured_repository or configured_repository != repository:
        raise ValueError('Explicit release repository opt-in must match GITHUB_REPOSITORY')
    return repository


def version(value):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise ValueError('Expected plain major.minor.patch version')
    parts = tuple(map(int, value.split('.')))
    if max(parts) > 65535:
        raise ValueError('Version exceeds Windows installer limits')
    return parts


def plan(repository, tag, releases, *, configured_repository):
    validate_repository(repository, configured_repository)
    if not tag.startswith(PREFIX):
        raise ValueError('Wrong release tag prefix')
    target = tag[len(PREFIX):]
    parts = version(target)
    if any(r['tagName'] == tag for r in releases):
        raise ValueError('Release already exists; never overwrite a published or draft version')
    published = [r for r in releases if not r['isDraft'] and r['tagName'].startswith(PREFIX)]
    if any(version(r['tagName'][len(PREFIX):]) >= parts for r in published):
        raise ValueError('Release must be newer than every published channel version')
    versions = [target]
    if not published:
        if parts[2] == 0:
            raise ValueError('First release needs patch >= 1 for a lower bootstrap version')
        versions.insert(0, f'{parts[0]}.{parts[1]}.{parts[2] - 1}')
    return {'version': target, 'versions': versions,
            'endpoint': f'https://github.com/{repository}/releases/latest/download/latest.json'}


def releases(repository):
    return json.loads(subprocess.check_output(
        ['gh', 'release', 'list', '--repo', repository, '--limit', '1000',
         '--json', 'tagName,isDraft'], text=True))


def manifest(repository, tag, root, *, configured_repository):
    validate_repository(repository, configured_repository)
    if not tag.startswith(PREFIX):
        raise ValueError('Wrong release destination')
    target = tag[len(PREFIX):]
    version(target)
    name = f'XHarness_{target}_x64-setup.exe'
    package = root / name
    if not package.is_file() or package.stat().st_size == 0:
        raise ValueError('Missing installer')
    signature = (root / (name + '.sig')).read_text(encoding='utf-8').strip()
    if not signature:
        raise ValueError('Missing installer signature')
    return {'version': target,
            'notes': '同学分发通道。更新包已签名；未购买 Windows 发布者证书。安装前请保存任务，确认重启会停止 Agent 和后台命令。',
            'pub_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'platforms': {'windows-x86_64': {
                'signature': signature,
                'url': f'https://github.com/{repository}/releases/download/{tag}/{name}'}}}


if __name__ == '__main__':
    command, tag = sys.argv[1:3]
    repository = os.environ['GITHUB_REPOSITORY']
    configured_repository = os.environ.get('XHARNESS_FRIENDS_RELEASE_REPOSITORY', '')
    validate_repository(repository, configured_repository)
    if command == 'plan':
        result = plan(repository, tag, releases(repository), configured_repository=configured_repository)
        with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as output:
            output.write('RELEASE_VERSION=' + result['version'] + '\n')
            output.write('BUILD_VERSIONS=' + ','.join(result['versions']) + '\n')
            output.write('XHARNESS_UPDATER_ENDPOINT=' + result['endpoint'] + '\n')
    elif command == 'manifest':
        root = Path(sys.argv[3])
        result = manifest(repository, tag, root, configured_repository=configured_repository)
        (root / 'latest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        files = sorted(p for p in root.iterdir() if p.is_file() and p.name != 'SHA256SUMS')
        (root / 'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in files), encoding='ascii')
    else:
        raise ValueError('Unknown command')
