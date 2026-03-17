#!/usr/bin/env python3
"""Local-only diagnostic packaging; reuse release version preparation.

No signing secrets, release mutation, user state or network access.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def validate(version, endpoint, public_key):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
        raise ValueError('Expected installed stable major.minor.patch version')
    url = urlsplit(endpoint)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.fragment:
        raise ValueError('Expected existing public HTTPS update endpoint')
    decoded = base64.b64decode(public_key, validate=True).decode('ascii')
    lines = decoded.strip().splitlines()
    if len(lines) != 2 or not lines[0].startswith('untrusted comment: minisign public key:'):
        raise ValueError('Only a minisign PUBLIC key is accepted')
    key = base64.b64decode(lines[1], validate=True)
    if len(key) != 42 or key[:2] != b'Ed':
        raise ValueError('Invalid updater public key')


def main():
    # A dedicated build branch may carry public inputs when the fork's default
    # branch has not registered workflow_dispatch yet. Never infer a channel.
    if os.environ.get('GITHUB_EVENT_NAME') == 'push':
        selected = json.loads((ROOT / '.github/local-diagnostic-build.json').read_text(encoding='utf-8'))
        version, endpoint, public_key = (selected[k] for k in ('version', 'endpoint', 'publicKey'))
    else:
        version = os.environ['DIAGNOSTIC_VERSION']
        endpoint = os.environ['XHARNESS_UPDATER_ENDPOINT']
        public_key = os.environ['XHARNESS_UPDATER_PUBKEY'].strip()
    validate(version, endpoint, public_key)
    if any('\n' in value or '\r' in value for value in (version, endpoint, public_key)):
        raise ValueError('Multiline workflow inputs are not accepted')
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if source != os.environ['GITHUB_SHA']:
        raise ValueError('Source differs from selected workflow ref')
    spec = importlib.util.spec_from_file_location('prepare', ROOT / 'scripts/prepare-desktop-test-version.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.prepare(version, public_key)
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as output:
        output.write(f'XHARNESS_UPDATER_ENDPOINT={endpoint}\nXHARNESS_UPDATER_PUBKEY={public_key}\n')
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    (dist / 'local-diagnostic-build.json').write_text(json.dumps({
        'source': source, 'version': version, 'endpoint': endpoint,
        'publicKey': public_key, 'localOnly': True, 'releasePublished': False,
    }, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
