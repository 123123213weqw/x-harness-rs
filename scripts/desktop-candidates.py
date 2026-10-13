#!/usr/bin/env python3
"""Prepare exact green master candidates, never publish or rebuild on promotion.

Uses the canonical ReleaseTask, protected signing workers and integrated native
acceptance. Only the allocation journal and trusted CI trigger are new. A lost
mutation reply is reconciled by GET, never blindly POSTed again.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


service = module('candidate_service', 'desktop-release-service.py')
release = service.release
build = module('candidate_build', 'desktop-release-build.py')
WORKFLOW = 'desktop-candidates.yml'
SCOPES = ('all', 'all-macos-preview', 'all-macos-selfsigned')
require = release.require


def candidate_prefix(run_id):
    require(re.fullmatch(r'[1-9][0-9]*', run_id or ''), 'Invalid automatic coordinator identity')
    return f'desktop-candidate-task-{run_id}-'


class CandidateCheckpoints(service.Checkpoints):
    def __init__(self, root, run_id, attempt, upload):
        require(re.fullmatch(r'[1-9][0-9]*', attempt or ''), 'Invalid coordinator attempt')
        self.root, self.prefix = root, candidate_prefix(run_id)
        self.attempt, self.upload, self.revision, self.last = attempt, upload, 0, None


class CandidateGitHub(service.HostedGitHub):
    def refs(self):
        return self.pages('git/matching-refs/tags/desktop-v?per_page=100', None)

    def tag(self, name):
        rows = self.get('git/matching-refs/tags/' + name)
        matches = [row for row in rows if row.get('ref') == 'refs/tags/' + name]
        require(len(matches) <= 1, 'Ambiguous candidate tag')
        return matches[0] if matches else None

    def create_tag(self, name, sha):
        # Allocation intent MUST already be checkpointed by reserve(). Capture
        # only the known HTTP conflict, never arbitrary credential diagnostics.
        try:
            result = subprocess.run(['gh', 'api', '--method', 'POST', self.root + '/git/refs',
                                     '--input', '-'], input=json.dumps({'ref': 'refs/tags/' + name, 'sha': sha}),
                                    text=True, encoding='utf-8', capture_output=True, timeout=90)
        except (OSError, subprocess.TimeoutExpired):
            return 'unknown'
        if result.returncode == 0:
            return 'accepted'
        return 'conflict' if '(HTTP 422)' in (result.stderr or '') else 'unknown'


def eligible_ci(client, event_id, event_attempt, sha):
    require(re.fullmatch(r'[1-9][0-9]*', event_id or '') and
            re.fullmatch(r'[1-9][0-9]*', event_attempt or '') and
            re.fullmatch(r'[0-9a-f]{40}', sha or ''), 'Invalid CI trigger identity')
    run = client.run(int(event_id))
    ci = release.contract.select_ci(client.ci(sha), sha)
    require(run.get('head_repository', {}).get('full_name') == client.repo
            and run.get('path') == '.github/workflows/ci.yml'
            and run.get('id') == ci['id'] == int(event_id)
            and run.get('run_attempt') == ci['run_attempt'] == int(event_attempt)
            and {key: run.get(key) for key in ci} == ci,
            'Only the latest successful same-repository master push CI may prepare a candidate')
    jobs = client.jobs(ci['id'], ci['run_attempt'])
    require(jobs and all(j.get('status') == 'completed' and j.get('conclusion') == 'success' for j in jobs),
            'Every master CI job must be successful; no skipped gates')
    master = client.master()
    require(master == sha or client.get(f'compare/{sha}...{master}')['status'] in ('ahead', 'identical'),
            'CI source is not in current master ancestry')
    return ci


def next_version(releases, refs):
    versions = []
    for tag in [row['tag_name'] for row in releases] + [row['ref'].removeprefix('refs/tags/') for row in refs]:
        for prefix in ('desktop-v', 'friends-v'):
            if tag.startswith(prefix):
                versions.append(release.contract.version(tag[len(prefix):]))
    major, minor, patch = max(versions, default=(0, 0, 0))
    return f'{major}.{minor}.{patch + 1}'


def reserve(client, journal, persist):
    """Monotonic lightweight tags reserve versions, including failed attempts.

    A confirmed 422 conflict may pick a new version. An unknown POST with no
    visible tag stops; a rerun must reconcile the SAME proposed tag first.
    No refs, drafts, assets or failed-version evidence are deleted or overwritten.
    """
    if journal.get('task'):
        return journal['task']
    for _ in range(4):
        intent = journal.get('allocation')
        if intent is None or intent['outcome'] == 'conflict':
            version = next_version(client.releases(), client.refs())
            intent = {'version': version, 'tag': 'desktop-v' + version, 'outcome': 'unknown'}
            journal.setdefault('allocations', []).append(intent)
            journal['allocation'] = intent
            persist(journal)  # Before the only non-idempotent tag POST.
            intent['outcome'] = client.create_tag(intent['tag'], journal['source_sha'])
            persist(journal)
        row = client.tag(intent['tag'])
        if intent['outcome'] == 'conflict' and row:
            continue  # A known rejected mutation, not an ambiguous network retry.
        if not (row and row.get('object', {}).get('type') == 'commit' and row['object'].get('sha') == journal['source_sha']):
            raise release.TaskError('Candidate tag outcome unresolved or changed; rerun this SAME coordinator, never reserve another version')
        state = release.new_task(client.repo, intent['version'], journal['scope'], journal['source_sha'],
                                 journal['publisher_pin'], pipeline=True, tagged_candidate=True)
        state['preparation_only'] = True
        journal['task'] = state
        persist(journal)
        return state
    raise release.TaskError('Concurrent version reservations exceeded the bounded conflict budget; resume this coordinator')


def validate_journal(journal, client, ci, sha, scope, pin):
    require(journal.get('schema') == 1 and journal.get('kind') == 'automatic-candidate'
            and journal.get('repository') == client.repo and journal.get('source_sha') == sha
            and journal.get('ci') == ci and journal.get('scope') == scope and journal.get('publisher_pin') == pin,
            'Restored automatic candidate identity or signing policy changed')
    if journal.get('allocation'):
        intent = journal['allocation']
        release.contract.version(intent['version'])
        require(intent['tag'] == 'desktop-v' + intent['version']
                and intent['outcome'] in ('unknown', 'accepted', 'conflict'), 'Invalid allocation journal')
    if journal.get('task'):
        task = journal['task']
        require(task.get('preparation_only') is True and task.get('tagged_candidate') is True
                and task.get('pipeline') is True and task.get('repository') == client.repo
                and task.get('source_sha') == sha and task.get('scope') == scope
                and task.get('macos_signing_fingerprint') == pin
                and task.get('version') == journal['allocation']['version'] and 'publish' not in task.get('stages', {}),
                'Automatic checkpoint cannot become a publication task')


def reuse_task(client, run_id, version, scope=None):
    """Explicit release entry: adopt immutable build, dispatch promotion ONLY.

    Authenticate the small plan artifact now; the existing hosted promoter
    freshly verifies all package signatures, unchanged draft, native receipts,
    latest exact-SHA CI and live channel again before its only publication.
    """
    require(re.fullmatch(r'[1-9][0-9]*', run_id or ''), 'Invalid candidate run id')
    run = build.successful_run(client.repo, run_id, None, '.github/workflows/desktop-release.yml')
    require(run['event'] == 'workflow_dispatch' and run['head_branch'].startswith('desktop-v'),
            'Reuse requires an automatic immutable tag candidate')
    token = run.get('display_title', '').removeprefix('release-task ')
    require(re.fullmatch(r'[0-9a-f]{32}', token), 'Candidate correlation identity missing')
    with tempfile.TemporaryDirectory(prefix='xharness-candidate-plan-') as folder:
        destination = Path(folder) / 'plan'
        build.download_artifact(client.repo, run, 'desktop-plan', destination)
        require({p.name for p in destination.iterdir()} == {'plan.json'}, 'Unexpected plan artifact files')
        plan = release.contract.validate_plan(build.load(destination / 'plan.json'))
    require(plan['repository'] == client.repo and plan['sha'] == run['head_sha']
            and plan['version'] == version and plan['tag'] == run['head_branch']
            and plan['release_run_id'] == run_id and plan['release_run_attempt'] == str(run['run_attempt'])
            and release.contract.platform_pipeline(plan) and plan.get('release_scope', 'all') in SCOPES
            and (scope is None or scope == plan.get('release_scope', 'all')), 'Candidate plan/version/scope mismatch')
    jobs = client.jobs(int(run_id), run['run_attempt'])
    names = {j.get('name') for j in jobs if j.get('status') == 'completed' and j.get('conclusion') == 'success'}
    require({'Signed ' + p + ' candidate' for p in build.PLATFORMS} <= names,
            'All four signed/native candidate workers must pass')
    require(release.contract.select_ci(client.ci(plan['sha']), plan['sha']) == plan['ci'],
            'CI reran or changed since candidate preparation; cannot reuse stale evidence')
    pin = client.publisher_pin() if plan.get('release_scope') == release.contract.MACOS_SELFSIGNED_SCOPE else None
    require(plan.get('macos_signing_fingerprint') == pin, 'Candidate publisher identity changed')
    state = release.new_task(client.repo, version, plan.get('release_scope', 'all'), plan['sha'], pin,
                             pipeline=True, tagged_candidate=True)
    state['reused_build'] = run_id
    state['phase'] = 'awaiting_confirmation'
    state['stages']['build'] = {'token': token, 'created': run['created_at'], 'dispatch': 'adopted',
                              'inputs': release.build_inputs(state), 'run_id': int(run_id),
                              'run_attempt': run['run_attempt'], 'verified_attempt': run['run_attempt'],
                              'status': 'completed', 'conclusion': 'success'}
    return state


def main():
    try:
        env = os.environ
        repo, sha, scope = env['GITHUB_REPOSITORY'], env['TRIGGER_SOURCE_SHA'], env['RELEASE_SCOPE']
        require(env.get('GITHUB_ACTIONS') == 'true' and env.get('RUNNER_ENVIRONMENT') == 'github-hosted'
                and env.get('GITHUB_REF') == 'refs/heads/master' and env.get('GITHUB_EVENT_NAME') == 'workflow_run'
                and env.get('GITHUB_WORKFLOW_REF') == repo + '/.github/workflows/' + WORKFLOW + '@refs/heads/master',
                'Automatic preparation requires the trusted master workflow_run controller')
        require(scope in SCOPES, 'Automatic preparation requires all four platforms; choose an explicit Mac signing policy')
        client = CandidateGitHub(repo, scope, env.get('XHARNESS_FRIENDS_RELEASE_REPOSITORY'), env.get('XHARNESS_MACOS_PREVIEW_CERT_SHA1'))
        ci = eligible_ci(client, env['TRIGGER_CI_RUN_ID'], env['TRIGGER_CI_ATTEMPT'], sha)
        pin = client.publisher_pin() if scope == release.contract.MACOS_SELFSIGNED_SCOPE else None
        root = Path(env['RUNNER_TEMP']) / 'desktop-candidate-prepare'
        root.mkdir(mode=0o700, exist_ok=False)
        journal = service.restore_checkpoint(client, root, candidate_prefix(env['GITHUB_RUN_ID']),
                                             env['GITHUB_RUN_ID'], env['GITHUB_SHA'])
        if journal is None:
            journal = {'schema': 1, 'kind': 'automatic-candidate', 'repository': repo, 'source_sha': sha,
                       'ci': ci, 'scope': scope, 'publisher_pin': pin, 'allocations': []}
        validate_journal(journal, client, ci, sha, scope, pin)
        action = ROOT / '.github/actions/desktop-release-service/index.cjs'
        def upload(name, path):
            result = subprocess.run(['node', str(action), 'checkpoint', name, str(path)], check=False)
            require(result.returncode == 0, 'Candidate checkpoint failed; no new mutation will be sent')
        persist = CandidateCheckpoints(root, env['GITHUB_RUN_ID'], env['GITHUB_RUN_ATTEMPT'], upload)
        persist(journal)
        state = reserve(client, journal, persist)
        task = release.ReleaseTask(client, state, lambda _: persist(journal))
        require(service.advance_until_done(task, False) == 'awaiting_confirmation', 'Preparation must stop before publication')
        build_run = state['stages']['build']
        ready = {'version': state['version'], 'source_sha': sha, 'release_scope': scope,
                 'ci': ci, 'release_run_id': build_run['run_id'], 'release_run_attempt': build_run['verified_attempt'],
                 'published': False}
        release.save(root / 'ready.json', ready)
        with open(env['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write(f"## Candidate {state['version']} ready (NOT published)\n\nSource: `{sha}`\n\n"
                          f"Build and all four native upgrades: https://github.com/{repo}/actions/runs/{build_run['run_id']}\n\n"
                          f"Explicit promotion, without rebuilding:\n```sh\npython3 -B scripts/release.py {state['version']} --repo {repo} "
                          f"--candidate-run-id {build_run['run_id']} --confirm-publish {state['version']}\n```\n")
        return 0
    except (release.TaskError, ValueError, KeyError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
