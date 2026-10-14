#!/usr/bin/env python3
"""Publish a verified lock-only upgrade PR. Never approves/merges/releases.

No checkout write credentials, personal token, force push, or external GitHub App.
The schedule runs trusted master code, not pull_request_target or PR code.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

spec = importlib.util.spec_from_file_location('runtime', Path(__file__).with_name('powershell-runtime.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def api(path, method='GET', body=None, allow_missing=False):
    args = ['gh', 'api', path, '--method', method]
    if body is not None:
        args += ['--input', '-']
    result = subprocess.run(args, input=json.dumps(body) if body is not None else None,
                            capture_output=True, text=True, timeout=60)
    if allow_missing and result.returncode and 'HTTP 404' in result.stderr:
        return None
    runtime.require(result.returncode == 0, f'GitHub {method} failed for {path}; check repository Actions PR-creation permissions')
    return json.loads(result.stdout) if result.stdout.strip() else None


def request_checks(prefix, branch, sha):
    runtime.require(re.fullmatch('[0-9a-f]{40}', sha), 'Invalid upgrade PR commit identity')
    for workflow in ('ci.yml', 'windows-runtime-gates.yml'):
        path = prefix + '/actions/workflows/' + workflow
        runs = api(path + '/runs?head_sha=' + sha + '&event=workflow_dispatch')
        if not runs['workflow_runs']:
            api(path + '/dispatches', 'POST', {'ref': branch})


def publish(candidate, repo, source_sha):
    runtime.validate_lock(candidate)
    current = runtime.load_lock()
    runtime.require(candidate['lts_series'] == current['lts_series'] and
                    tuple(map(int, candidate['version'].split('.'))) > tuple(map(int, current['version'].split('.'))), 'Only newer same-series patches may be proposed')
    runtime.require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) and
                    re.fullmatch('[0-9a-f]{40}', source_sha), 'Invalid trusted repository/source identity')
    branch = 'bot/powershell-' + candidate['version']
    prefix = 'repos/' + repo
    existing = api(prefix + '/git/ref/heads/' + branch, allow_missing=True)
    if existing is not None:
        prs = api(prefix + '/pulls?state=all&head=' + repo.split('/')[0] + ':' + branch)
        if prs:
            runtime.require(len(prs) == 1, 'Ambiguous existing bot PR; manual triage required')
            if prs[0]['state'] == 'open':
                # Recover a failure after PR creation/one dispatch. Existing
                # exact-SHA runs are never repeated every week.
                request_checks(prefix, branch, prs[0]['head']['sha'])
            print('Upgrade PR already exists; no duplicate commit or CI run: ' + prs[0]['html_url'])
            return
    else:
        api(prefix + '/git/refs', 'POST', {'ref': 'refs/heads/' + branch, 'sha': source_sha})
    old = api(prefix + '/contents/runtime/powershell.lock.json?ref=' + branch)
    content = json.dumps(candidate, indent=2) + '\n'
    recovered = existing is not None and old.get('content') and json.loads(base64.b64decode(old['content'])) == candidate
    if recovered:
        commit = api(prefix + '/commits/' + existing['object']['sha'])
        runtime.require([f['filename'] for f in commit.get('files', [])] == ['runtime/powershell.lock.json'], 'Uncertain partial bot branch; no force push or overwrite')
    else:
        runtime.require(existing is None or existing['object']['sha'] == source_sha, 'Uncertain partial bot branch; no force push or overwrite')
        api(prefix + '/contents/runtime/powershell.lock.json', 'PUT', {
            'branch': branch, 'sha': old['sha'], 'message': 'chore(runtime): pin PowerShell ' + candidate['version'],
            'content': base64.b64encode(content.encode()).decode()})
    pr = api(prefix + '/pulls', 'POST', {'head': branch, 'base': 'master',
        'title': 'chore(runtime): update bundled PowerShell to ' + candidate['version'],
        'body': 'Updates only the canonical runtime lock within the approved LTS series. Official release digest and hashes.sha256 agree; the complete archive, licenses and native .NET loader dependencies were verified. Normal cross-platform CI is explicitly dispatched because GITHUB_TOKEN-created PR runs can require approval. No auto-merge, review approval or release.'})
    # Dispatch is a supported GITHUB_TOKEN trigger. Release steps remain guarded
    # by push-to-master, and the ordinary Windows PR smoke runs on dispatch.
    request_checks(prefix, branch, pr['head']['sha'])
    print('Created upgrade PR with regression CI requested: ' + pr['html_url'])


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('proposal', type=Path)
    args = p.parse_args()
    if not args.proposal.exists():
        print('No PowerShell upgrade proposal; no repository changes')
        return
    publish(runtime.load_lock(args.proposal), os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_SHA'])


if __name__ == '__main__':
    main()
