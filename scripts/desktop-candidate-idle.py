#!/usr/bin/env python3
"""Read-only admission for idle release prebuilds. No tags, dispatch or publish."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('idle_candidates', ROOT / 'scripts/desktop-candidates.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
require = c.require
ACTIVE = ('queued', 'in_progress', 'requested', 'waiting', 'pending')
QUIET_SECONDS = 600
CONTROLLER = '.github/workflows/' + c.WORKFLOW
PREPARE_STEP = 'Prepare and accept immutable four-platform candidate, NEVER promote'
PRIORITY_WORKFLOWS = frozenset({
    '.github/workflows/ci.yml', '.github/workflows/friends-release.yml',
    '.github/workflows/installer-process-probe.yml',
    '.github/workflows/windows-direct-update-acceptance.yml',
    '.github/workflows/windows-migration-acceptance.yml',
    '.github/workflows/macos-preview-bridge.yml',
})


def decision(reason, sha, ci=None, *, prepare=False, run_id=None, version=None):
    return {'prepare': prepare, 'reason': reason, 'source_sha': sha, 'ci': ci,
            'related_run_id': run_id, 'version': version, 'published': False}


def history(client, workflow, sha):
    # GitHub caps filtered run searches at 1,000 rows. Never assume a truncated
    # result proves absence of an earlier allocation or ambiguous dispatch.
    rows = client.pages(f'actions/workflows/{workflow}/runs?head_sha={sha}&per_page=100', 'workflow_runs')
    require(len(rows) < 1000, 'Candidate history limit reached; inspect existing runs before allocating')
    for row in rows:
        require(type(row.get('id')) is int and row['id'] > 0
                and row.get('path') == '.github/workflows/' + workflow and row.get('head_sha') == sha
                and row.get('head_repository', {}).get('full_name') == client.repo,
                'Candidate history provenance mismatch')
    return sorted(rows, key=lambda row: int(row['id']), reverse=True)


def busy_run(client, own_run):
    for status in ACTIVE:
        rows = client.pages(f'actions/runs?status={status}&per_page=100', 'workflow_runs')
        require(len(rows) < 1000, 'Active workflow search limit reached; defer preparation')
        for row in rows:
            require(type(row.get('id')) is int and row['id'] > 0, 'Invalid active workflow identity')
            # Other controllers queue behind our global lock and do no heavy
            # work. Treating those as load would make controllers block each other.
            if str(row['id']) == own_run or row.get('path') == CONTROLLER:
                continue
            require(row.get('status') in (*ACTIVE, 'completed'), 'Unknown workflow activity state')
            path = row.get('path', '')
            priority = path in PRIORITY_WORKFLOWS or path.startswith('.github/workflows/desktop-')
            # Unrelated queued housekeeping (for example a stalled mirror) owns
            # no runner and must not starve all future release preparation.
            if row['status'] == 'in_progress' or priority and row['status'] != 'completed':
                return row['id']
    return None


def could_own_intent(client, run):
    """A cancelled pending controller never ran the journaled mutation step.

    GitHub may replace a pending concurrency-group member even with
    cancel-in-progress=false. Do not mistake that for an uncertain release POST.
    Anything that reached the preparation action still needs same-run recovery.
    """
    attempt = run.get('run_attempt')
    require(type(attempt) is int and attempt > 0, 'Candidate controller attempt missing')
    jobs = client.jobs(run['id'], attempt)
    if not jobs:
        require(run.get('conclusion') == 'cancelled', 'Cannot establish whether failed controller allocated a version')
        return False
    steps = [s for job in jobs for s in job.get('steps', []) if s.get('name') == PREPARE_STEP]
    if not steps:
        require(all(job.get('status') == 'completed' and job.get('conclusion') in ('skipped', 'cancelled')
                    and not job.get('steps') for job in jobs), 'Candidate preparation step evidence missing')
        return False
    require(len(steps) == 1, 'Ambiguous candidate preparation step evidence')
    return steps[0].get('conclusion') != 'skipped'


def select(client, scope, controller_sha, own_run, trigger=None, *, now=None):
    require(scope in c.SCOPES and re.fullmatch(r'[0-9a-f]{40}', controller_sha or ''),
            'Invalid idle candidate source or four-platform policy')
    require(re.fullmatch(r'[1-9][0-9]*', own_run or ''), 'Invalid idle coordinator identity')
    sha = controller_sha
    if client.master() != sha:
        return decision('master_moved', sha)
    rows = [r for r in client.ci(sha) if r.get('head_sha') == sha
            and r.get('event') == 'push' and r.get('head_branch') == 'master']
    if not rows:
        return decision('waiting_for_ci', sha)
    latest = max(rows, key=lambda row: (int(row['id']), int(row.get('run_attempt', 1))))
    if trigger and trigger != (str(latest['id']), str(latest.get('run_attempt', 1)), sha):
        return decision('superseded_trigger', sha)
    if latest.get('status') != 'completed' or latest.get('conclusion') != 'success':
        return decision('waiting_for_ci', sha)
    ci = c.eligible_ci(client, str(latest['id']), str(latest.get('run_attempt', 1)), sha)
    stamp = latest.get('updated_at')
    require(isinstance(stamp, str), 'CI completion timestamp missing')
    finished = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    require(finished.tzinfo is not None, 'CI completion timestamp must include a timezone')
    age = ((now or datetime.now(timezone.utc)) - finished).total_seconds()
    require(age >= 0, 'CI completion timestamp is in the future')
    if age < QUIET_SECONDS:
        return decision('quiet_period', sha, ci)
    busy = busy_run(client, own_run)
    if busy:
        return decision('repository_busy', sha, ci, run_id=busy)

    # Any unfinished/failed controller may own an allocation not yet visible as
    # a build run. Only a rerun of THAT journal may reconcile the uncertain POST.
    for row in history(client, c.WORKFLOW, sha):
        if str(row['id']) == own_run:
            continue
        require(row.get('head_branch') == 'master'
                and row.get('event') in ('workflow_run', 'schedule', 'workflow_dispatch'),
                'Unexpected candidate controller origin')
        if row.get('status') != 'completed':
            # Queued controllers have not acquired this workflow's global lock.
            if row.get('status') == 'queued':
                continue
            return decision('resume_existing_controller', sha, ci, run_id=row['id'])
        if row.get('conclusion') != 'success' and could_own_intent(client, row):
            return decision('resume_existing_controller', sha, ci, run_id=row['id'])

    for row in history(client, 'desktop-release.yml', sha):
        if row.get('event') != 'workflow_dispatch' or not row.get('head_branch', '').startswith('desktop-v'):
            continue  # Do not adopt a manual master build as an immutable prebuild.
        version = row['head_branch'].removeprefix('desktop-v')
        c.release.contract.version(version)
        if row.get('status') != 'completed' or row.get('conclusion') != 'success':
            return decision('inspect_existing_build', sha, ci, run_id=row['id'], version=version)
        try:
            # Authenticates the small plan, exact CI attempt, signer and all four
            # native workers. Never download packages or use a cache as evidence.
            c.reuse_task(client, str(row['id']), version, scope)
        except c.release.TransportError:
            raise  # A failed read is not a failed candidate or permission to rebuild.
        except ValueError:
            return decision('candidate_evidence_changed', sha, ci, run_id=row['id'], version=version)
        return decision('candidate_ready', sha, ci, run_id=row['id'], version=version)

    # Close the cheap planning race; allocation/dispatch remain pinned and are
    # revalidated by the existing journaled coordinator after this admission.
    if client.master() != sha:
        return decision('master_moved', sha, ci)
    c.eligible_ci(client, str(ci['id']), str(ci['run_attempt']), sha)
    busy = busy_run(client, own_run)
    if busy:
        return decision('repository_busy', sha, ci, run_id=busy)
    return decision('idle_green_master', sha, ci, prepare=True)


def hosted(env):
    repo, scope = c.trusted_controller(env)
    client = c.CandidateGitHub(repo, scope, env.get('XHARNESS_FRIENDS_RELEASE_REPOSITORY'),
                               env.get('XHARNESS_MACOS_PREVIEW_CERT_SHA1'))
    if env['GITHUB_RUN_ATTEMPT'] != '1':
        # Recovery precedes idle/current-master selection. Never rebind an old
        # coordinator to a new source, scope or version on rerun.
        with tempfile.TemporaryDirectory(prefix='candidate-idle-restore-', dir=env['RUNNER_TEMP']) as folder:
            state = c.service.restore_checkpoint(client, Path(folder), c.candidate_prefix(env['GITHUB_RUN_ID']),
                                                  env['GITHUB_RUN_ID'], env['GITHUB_SHA'])
        require(state is not None, 'No candidate journal to resume; inspect this coordinator')
        sha = state['source_sha']
        ci = c.eligible_ci(client, str(state['ci']['id']), str(state['ci']['run_attempt']), sha)
        pin = client.publisher_pin() if scope == c.release.contract.MACOS_SELFSIGNED_SCOPE else None
        c.validate_journal(state, client, ci, sha, scope, pin)
        result = decision('resume_same_journal', sha, ci, prepare=True)
    else:
        trigger = None
        if env['GITHUB_EVENT_NAME'] == 'workflow_run':
            trigger = (env['TRIGGER_CI_RUN_ID'], env['TRIGGER_CI_ATTEMPT'], env['TRIGGER_SOURCE_SHA'])
        result = select(client, scope, env['GITHUB_SHA'], env['GITHUB_RUN_ID'], trigger)
    write_result(env, repo, result)
    return result


def write_result(env, repo, result):
    c.release.save(Path(env['RUNNER_TEMP']) / 'desktop-candidate-idle.json', result)
    ci = result['ci'] or {}
    with open(env['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
        stream.write(f"prepare={str(result['prepare']).lower()}\nsource_sha={result['source_sha']}\n"
                     f"ci_run_id={ci.get('id', '')}\nci_attempt={ci.get('run_attempt', '')}\n")
    with open(env['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
        stream.write(f"## Idle release prebuild: {result['reason']}\n\nSource: `{result['source_sha']}`. "
                     "No publication or installation is authorized by this workflow.\n\n")
        if result['related_run_id']:
            stream.write(f"Existing work: https://github.com/{repo}/actions/runs/{result['related_run_id']}\n\n")
        if result['reason'] == 'candidate_ready':
            stream.write(f"Reuse the accepted bytes without rebuilding:\n```sh\npython3 -B scripts/release.py "
                         f"{result['version']} --repo {repo} --candidate-run-id {result['related_run_id']} "
                         f"--confirm-publish {result['version']}\n```\n")
        elif result['reason'] in ('resume_existing_controller', 'inspect_existing_build', 'candidate_evidence_changed'):
            stream.write("Inspect/recover that run; no replacement version or failed native gate is retried automatically.\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect', action='store_true', help='Read-only live admission preview, never dispatch')
    parser.add_argument('--repo')
    parser.add_argument('--scope', choices=c.SCOPES, default='all-macos-preview')
    args = parser.parse_args()
    try:
        if args.inspect:
            client = c.release.GitHub(args.repo or '')
            require(client.opted_in(), 'Repository release opt-in missing')
            result = select(client, args.scope, client.master(), '1')
        else:
            require(args.repo is None, 'Hosted repository comes only from trusted workflow context')
            result = hosted(os.environ)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, KeyError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
