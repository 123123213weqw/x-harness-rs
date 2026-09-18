#!/usr/bin/env python3
"""Single desktop release task. Python + authenticated gh; never compiles Rust.

All signing, provenance, native acceptance and publication remain in the existing
hosted workflows. This file only coordinates their public identities.
"""
import argparse
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote
import uuid

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('release_contract', ROOT / 'scripts/desktop-release.py')
contract = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(contract)
WORKFLOWS = {
    'build': 'desktop-release.yml',
    'unix': 'desktop-unix-update-acceptance.yml',
    'windows': 'desktop-windows-update-acceptance.yml',
    'publish': 'desktop-promote.yml',
}
SCOPES = ('all-macos-preview', 'windows-linux', 'all')


class TaskError(ValueError):
    pass


class TransportError(TaskError):
    pass


def require(condition, message):
    if not condition:
        raise TaskError(message)


def gh(arguments, payload=None):
    try:
        result = subprocess.run(['gh', *arguments], input=json.dumps(payload) if payload is not None else None,
                                text=True, encoding='utf-8', stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=90)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise TransportError('GitHub CLI unavailable or timed out; resume the same task, do not redispatch manually') from error
    if result.returncode:
        # Do not persist arbitrary CLI diagnostics, credentials or environment.
        raise TransportError('GitHub request failed; check gh authentication/network and resume the same task')
    return json.loads(result.stdout) if result.stdout.strip() else None


class GitHub:
    def __init__(self, repo):
        require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo), 'Invalid repository')
        self.repo = repo
        self.root = f'repos/{repo}'

    def get(self, path):
        return gh(['api', f'{self.root}/{path}'])

    def pages(self, path, field):
        pages = gh(['api', '--paginate', '--slurp', f'{self.root}/{path}'])
        return [item for page in pages for item in (page[field] if field else page)]

    def master(self):
        return self.get('git/ref/heads/master')['object']['sha']

    def opted_in(self):
        return self.get('actions/variables/XHARNESS_FRIENDS_RELEASE_REPOSITORY')['value'] == self.repo

    def releases(self):
        return self.pages('releases?per_page=100', None)

    def ci(self, sha):
        return self.pages(f'actions/workflows/ci.yml/runs?head_sha={sha}&event=push&per_page=100', 'workflow_runs')

    def find(self, workflow, intent):
        created = quote('>=' + intent['created'], safe='')
        runs = self.pages(f'actions/workflows/{workflow}/runs?event=workflow_dispatch&created={created}&per_page=100', 'workflow_runs')
        return [r for r in runs if r.get('display_title') == 'release-task ' + intent['token']]

    def run(self, run_id):
        return self.get(f'actions/runs/{run_id}')

    def jobs(self, run_id, attempt):
        return self.pages(f'actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100', 'jobs')

    def dispatch(self, workflow, inputs):
        gh(['api', '--method', 'POST', f'{self.root}/actions/workflows/{workflow}/dispatches', '--input', '-'],
           {'ref': 'master', 'inputs': inputs})


def save(path, state):
    path = Path(path)
    require(not path.is_symlink(), 'Task state must not be a symlink')
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.release-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != 'nt':
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def task_lock(path):
    # OS-owned lock: a killed CLI leaves no stale PID lock to manually delete.
    path = Path(str(path) + '.lock')
    path.parent.mkdir(parents=True, exist_ok=True)
    require(not path.is_symlink(), 'Task lock must not be a symlink')
    stream = path.open('a+b')
    locked = False
    try:
        if os.name == 'nt':
            import msvcrt
            stream.seek(0, 2)
            if stream.tell() == 0:
                stream.write(b'0'); stream.flush()
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise TaskError('This release task is already running') from error
        else:
            import fcntl
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise TaskError('This release task is already running') from error
        locked = True
        yield
    finally:
        if locked:
            if os.name == 'nt':
                stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)
        stream.close()


def new_task(repo, version, scope, sha):
    contract.version(version)
    require(scope in SCOPES and re.fullmatch(r'[0-9a-f]{40}', sha or ''), 'Invalid scope or source SHA')
    return {'schema': 1, 'repository': repo, 'version': version, 'scope': scope,
            'source_sha': sha, 'phase': 'waiting_ci', 'stages': {}, 'history': []}


class ReleaseTask:
    def __init__(self, client, state, persist):
        require(state.get('schema') == 1 and state.get('repository') == client.repo, 'Task repository/schema mismatch')
        new_task(client.repo, state['version'], state['scope'], state['source_sha'])
        self.client, self.state, self.persist = client, state, persist

    def checkpoint(self, phase):
        self.state['phase'] = phase
        self.persist(self.state)
        return phase

    def validate_run(self, stage, run, intent):
        require(run.get('path') == '.github/workflows/' + WORKFLOWS[stage]
                and run.get('event') == 'workflow_dispatch' and run.get('head_branch') == 'master'
                and run.get('head_repository', {}).get('full_name') == self.client.repo
                and run.get('display_title') == 'release-task ' + intent['token'],
                f'{stage}: workflow provenance/correlation mismatch')
        require(isinstance(run.get('id'), int) and run['id'] > 0
                and isinstance(run.get('run_attempt'), int) and run['run_attempt'] > 0,
                f'{stage}: invalid run identity')
        if stage == 'build':
            require(run.get('head_sha') == self.state['source_sha'], 'master moved before build; source is locked, do not reuse this tag for other code')
        if intent.get('verified_attempt'):
            require(run['run_attempt'] == intent['verified_attempt'], f'{stage}: verified workflow was rerun; downstream evidence is stale')

    def stage(self, name, inputs, *, dispatch, retry):
        stages = self.state['stages']
        intent = stages.get(name)
        if intent is None:
            if not dispatch:
                return False
            intent = {'token': uuid.uuid4().hex, 'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                      'dispatch': 'unknown', 'inputs': inputs}
            stages[name] = intent
            # Write-ahead intent, before the non-idempotent HTTP POST.
            self.checkpoint(name + '_dispatching')
            try:
                self.client.dispatch(WORKFLOWS[name], {**inputs, 'orchestration_id': intent['token']})
            except TransportError:
                self.checkpoint(name + '_dispatch_unknown')
                return False
            intent['dispatch'] = 'accepted'
            self.persist(self.state)
        require(intent['inputs'] == inputs, f'{name}: task inputs changed; refusing to mix candidates')
        if intent.get('run_id'):
            run = self.client.run(intent['run_id'])
        else:
            found = self.client.find(WORKFLOWS[name], intent)
            require(len(found) <= 1, f'{name}: duplicate correlated workflows; manual inspection required')
            if not found:
                self.checkpoint(name + ('_dispatch_unknown' if intent['dispatch'] == 'unknown' else '_queued'))
                return False  # Never blindly send the POST again, including after a CLI crash.
            run = found[0]
        self.validate_run(name, run, intent)
        intent.update(run_id=run['id'], run_attempt=run['run_attempt'], status=run['status'], conclusion=run.get('conclusion'))
        self.checkpoint(name + '_running')
        if run['status'] != 'completed':
            return False
        if run['conclusion'] != 'success':
            self.checkpoint(name + '_failed')
            if retry and dispatch:
                if name in ('build', 'publish'):
                    existing = [r for r in self.client.releases() if r['tag_name'] == 'desktop-v' + self.state['version']]
                    require(not existing, f'{name}: draft/publication already exists; inspect receipts, never overwrite or delete it automatically')
                self.state['history'].append({'stage': name, **intent})
                del stages[name]
                self.checkpoint(name + '_retry_ready')
                return self.stage(name, inputs, dispatch=True, retry=False)
            raise TaskError(f'{name} failed (run {run["id"]}); use --retry after inspecting the failure')
        jobs = self.client.jobs(run['id'], run['run_attempt'])
        require(jobs and all(j['status'] == 'completed' and j['conclusion'] == 'success' for j in jobs),
                f'{name}: every required job must pass; skipped/cancelled jobs do not count')
        intent['verified_attempt'] = run['run_attempt']
        self.persist(self.state)
        return True

    def advance(self, *, dispatch=True, retry=False, confirm=None):
        if confirm is not None:
            require(confirm == self.state['version'], 'Publication confirmation must exactly match the version')
            require(self.state['phase'] == 'awaiting_confirmation' or 'publish' in self.state['stages'],
                    'First finish preparation; only then confirm the exact candidate')
        require(self.client.opted_in(), 'Repository has not opted into this release channel')
        sha = self.state['source_sha']
        if 'build' not in self.state['stages']:
            require(self.client.master() == sha, 'master changed before build; review the new source in a new task')
            runs = self.client.ci(sha)
            matches = [r for r in runs if r.get('head_sha') == sha and r.get('head_branch') == 'master' and r.get('event') == 'push']
            require(matches, 'No exact-SHA master CI found')
            newest = max(matches, key=lambda r: r['id'])
            if newest['status'] != 'completed':
                return self.checkpoint('waiting_ci')
            contract.select_ci(runs, sha)
            jobs = self.client.jobs(newest['id'], newest['run_attempt'])
            require(jobs and all(j['status'] == 'completed' and j['conclusion'] == 'success' for j in jobs), 'Master CI has non-passing jobs')
            releases = [{'tagName': r['tag_name'], 'isDraft': r['draft']} for r in self.client.releases()]
            contract.make_plan(self.client.repo, self.client.repo, 'desktop-v' + self.state['version'], sha, 1, 1,
                               releases, runs, self.state['scope'])
        inputs = {'release_tag': 'desktop-v' + self.state['version'], 'release_scope': self.state['scope'],
                  'prepare_tag': True, 'expected_sha': sha}
        if not self.stage('build', inputs, dispatch=dispatch, retry=retry):
            return self.state['phase']
        build_id = str(self.state['stages']['build']['run_id'])
        unix = self.stage('unix', {'mode': 'candidate', 'release_run_id': build_id}, dispatch=dispatch, retry=retry)
        windows = self.stage('windows', {'release_run_id': build_id}, dispatch=dispatch, retry=retry)
        if not (unix and windows):
            return self.checkpoint('acceptance_running')
        if confirm is None and 'publish' not in self.state['stages']:
            return self.checkpoint('awaiting_confirmation')
        inputs = {'release_run_id': build_id,
                  'unix_acceptance_run_id': str(self.state['stages']['unix']['run_id']),
                  'windows_acceptance_run_id': str(self.state['stages']['windows']['run_id'])}
        if self.stage('publish', inputs, dispatch=dispatch, retry=retry):
            return self.checkpoint('published')
        return self.state['phase']


def view(state):
    return {key: state[key] for key in ('repository', 'version', 'scope', 'source_sha', 'phase')} | {
        'runs': {name: {key: row.get(key) for key in ('run_id', 'status', 'conclusion', 'dispatch')} for name, row in state['stages'].items()},
        'next': ('Re-run with --confirm-publish ' + state['version']) if state['phase'] == 'awaiting_confirmation' else 'Resume with the same version; --status is read-only',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version')
    parser.add_argument('--platforms', choices=SCOPES, default=None)
    parser.add_argument('--repo')
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.xharness' / 'release-tasks')
    parser.add_argument('--status', action='store_true', help='Read GitHub status without triggering any workflow')
    parser.add_argument('--no-wait', action='store_true', help='Advance once and exit; invoke again to resume')
    parser.add_argument('--retry', action='store_true', help='Retry a known failed stage once; never resend an uncertain dispatch')
    parser.add_argument('--confirm-publish', metavar='VERSION')
    parser.add_argument('--timeout', type=int, default=14400)
    parser.add_argument('--poll', type=int, default=30)
    args = parser.parse_args()
    try:
        contract.version(args.version)
        require(args.timeout > 0 and args.poll > 0, 'Timeout and poll must be positive')
        require(not (args.status and (args.retry or args.confirm_publish)), 'Status must not include mutation flags')
        repo = args.repo or gh(['repo', 'view', '--json', 'nameWithOwner'])['nameWithOwner']
        client = GitHub(repo)
        path = args.state_dir / repo.replace('/', '--') / (args.version + '.json')
        with task_lock(path):
            require(not path.is_symlink(), 'Task state must not be a symlink')
            if path.exists():
                state = json.loads(path.read_text(encoding='utf-8'))
                require(state['version'] == args.version and (args.platforms is None or state['scope'] == args.platforms), 'Cannot change an existing task version/scope')
            else:
                require(not args.status and args.confirm_publish is None, 'No task exists; prepare this version first')
                state = new_task(repo, args.version, args.platforms or 'all-macos-preview', client.master())
                save(path, state)
            task = ReleaseTask(client, state, lambda value: save(path, value))
            deadline, previous = time.monotonic() + args.timeout, None
            retry, confirm = args.retry, args.confirm_publish
            while True:
                phase = task.advance(dispatch=not args.status, retry=retry, confirm=confirm)
                retry, confirm = False, None
                output = json.dumps(view(state), ensure_ascii=False, sort_keys=True)
                if output != previous:
                    print(output, flush=True); previous = output
                if args.status or args.no_wait or phase in ('awaiting_confirmation', 'published'):
                    return 0
                if time.monotonic() >= deadline:
                    print('Timed out waiting; task is saved. Resume the same command.', file=sys.stderr)
                    return 3
                time.sleep(args.poll)
    except (TaskError, ValueError, KeyError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print('Stopped waiting, not cancelling remote work. Resume the same version.', file=sys.stderr)
        return 130


if __name__ == '__main__':
    sys.exit(main())
