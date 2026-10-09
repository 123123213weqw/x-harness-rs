#!/usr/bin/env python3
"""Real artifact round-trip in disposable CI; no release dispatch or credentials.

This tests checkpoint infrastructure only, not native install acceptance.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('hosted_checkpoint_test', ROOT / 'scripts/desktop-release-service.py')
service = importlib.util.module_from_spec(spec); spec.loader.exec_module(service)
e = os.environ
service.require(e.get('GITHUB_ACTIONS') == 'true' and e.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'CI only')
service.require(e.get('GITHUB_WORKFLOW_REF', '').startswith(e['GITHUB_REPOSITORY'] + '/.github/workflows/ci.yml@'), 'Only the no-secret CI checkpoint rehearsal')
client = service.release.GitHub(e['GITHUB_REPOSITORY'])
current = client.run(int(e['GITHUB_RUN_ID']))
source = current['head_sha']  # PR runs may identify the PR head, not GITHUB_SHA's merge checkout.
root = Path(e['RUNNER_TEMP']) / 'release-checkpoint-rehearsal'
root.mkdir(mode=0o700, exist_ok=False)
def upload(name, path):
    subprocess.run(['node', str(ROOT / '.github/actions/desktop-release-service/index.cjs'), 'checkpoint', name, str(path)], check=True)
persist = service.Checkpoints(root, '0.0.0', e['GITHUB_RUN_ID'], e['GITHUB_RUN_ATTEMPT'], upload)
first = {'checkpoint_test_only': True, 'source_sha': source, 'revision': 1}
last = {**first, 'revision': 2}
persist(first); persist(last); persist(last)
assert persist.revision == 2
for n in range(6):
    rows = client.pages(f"actions/runs/{e['GITHUB_RUN_ID']}/artifacts?per_page=100", 'artifacts')
    selected = service.latest_checkpoint(rows, '0.0.0', e['GITHUB_RUN_ID'], source)
    if selected and selected['name'].endswith('-000002'): break
    if n == 5: raise ValueError('Checkpoint artifact did not become readable within the bounded deadline')
    time.sleep(5)
restored = service.restore(client, root, '0.0.0', e['GITHUB_RUN_ID'], source)
assert restored == last
with open(e['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
    stream.write('## Release checkpoint rehearsal\nTwo immutable revisions uploaded; the highest revision was downloaded and compared byte-for-byte. No release dispatch, signing key or native installation was used.\n')
print('Hosted checkpoint upload/latest-revision/restore round-trip passed.')
