#!/usr/bin/env python3
"""Hosted release coordinator. Persist write-ahead state in immutable run artifacts.

The existing ReleaseTask owns all gates; this runner only owns placement and
bounded read/transport recovery. It never retries a failed build or publication.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_task', ROOT / 'scripts/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
WORKFLOW = 'desktop-release-service.yml'


def require(condition, message):
    if not condition:
        raise release.TaskError(message)


def artifact_prefix(version, run_id):
    release.contract.version(version)
    require(re.fullmatch(r'[1-9][0-9]*', run_id or ''), 'Invalid service run identity')
    return f'release-task-{version}-{run_id}-'


def handoff(client, path, version, scope, publish, *, status=False):
    """One local write-ahead dispatch; the laptop is not the release worker."""
    release.contract.version(version)
    require((scope is None or scope in release.SCOPES) and type(publish) is bool, 'Invalid hosted release policy')
    with release.task_lock(path):
        require(not path.is_symlink(), 'Unsafe handoff file')
        if path.exists():
            state = json.loads(path.read_text(encoding='utf-8'))
            require(state.get('kind') == 'hosted' and state['repository'] == client.repo
                    and state['version'] == version and (scope is None or state['scope'] == scope)
                    and (status or state['publish_after_acceptance'] == publish), 'Existing task cannot be rebound or transferred to another mode')
        else:
            require(not status, 'No hosted task exists')
            scope = scope or 'all-macos-preview'
            require(client.opted_in(), 'Repository has not opted into this release channel')
            state = {'kind': 'hosted', 'repository': client.repo, 'version': version, 'scope': scope,
                'source_sha': client.master(), 'publish_after_acceptance': publish, 'intent': {
                    'token': release.uuid.uuid4().hex,
                    'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'dispatch': 'unknown'}}
            release.new_task(client.repo, version, scope, state['source_sha'],
                             client.publisher_pin() if scope == release.contract.MACOS_SELFSIGNED_SCOPE else None)
            release.save(path, state)  # BEFORE the only POST; lost replies never permit another POST.
            try:
                client.dispatch(WORKFLOW, {'orchestration_id': state['intent']['token'], 'version': version,
                    'expected_sha': state['source_sha'], 'release_scope': scope, 'publish_after_acceptance': publish})
            except release.TransportError:
                pass
            else:
                state['intent']['dispatch'] = 'accepted'
                release.save(path, state)
        intent = state['intent']
        if intent.get('run_id'):
            rows = [client.run(intent['run_id'])]
        else:
            rows = client.find(WORKFLOW, intent)
        require(len(rows) <= 1, 'Duplicate hosted release coordinators; manual inspection required')
        if not rows:
            return {'version': version, 'dispatch': intent['dispatch'], 'next': 'Resume the same hosted command; do not send another dispatch'}
        run = rows[0]
        require(run.get('path') == '.github/workflows/' + WORKFLOW and run.get('event') == 'workflow_dispatch'
                and run.get('head_branch') == 'master' and run.get('head_sha') == state['source_sha']
                and run.get('head_repository', {}).get('full_name') == client.repo
                and run.get('display_title') == 'release-task ' + intent['token'], 'Hosted handoff source/correlation mismatch')
        intent['run_id'] = run['id']
        release.save(path, state)
        return {'version': version, 'status': run['status'], 'conclusion': run.get('conclusion'),
                'url': f"https://github.com/{client.repo}/actions/runs/{run['id']}",
                'next': 'A failed/expired coordinator resumes by rerunning THIS run, not by dispatching another version task'}


def latest_checkpoint(rows, version, run_id, sha):
    prefix = artifact_prefix(version, run_id)
    candidates = []
    for row in rows:
        name = row.get('name', '')
        if not name.startswith(prefix):
            continue
        match = re.fullmatch(re.escape(prefix) + r'([1-9][0-9]*)-([0-9]{6})', name)
        require(match is not None, 'Malformed release checkpoint identity')
        require(row.get('workflow_run', {}).get('head_sha') == sha, 'Checkpoint source differs from coordinator')
        candidates.append(((int(match[1]), int(match[2])), row))
    if not candidates:
        return None
    require(len({key for key, _ in candidates}) == len(candidates), 'Ambiguous checkpoint revision')
    latest = max(candidates, key=lambda pair: pair[0])[1]
    require(not latest['expired'], 'Latest release checkpoint expired; never start this version afresh')
    return latest


def restore(client, root, version, run_id, sha):
    row = latest_checkpoint(client.pages(f'actions/runs/{run_id}/artifacts?per_page=100', 'artifacts'), version, run_id, sha)
    if row is None:
        # A rerun without evidence may have lost a dispatch intent: fail closed.
        require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'No checkpoint for a rerun; inspect remote runs, do not redispatch')
        return None
    destination = root / 'restore'
    try:
        subprocess.run(['gh', 'run', 'download', run_id, '--repo', client.repo, '--name', row['name'], '--dir', str(destination)],
                       check=True, timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except (subprocess.SubprocessError, OSError) as error:
        raise release.TransportError('Checkpoint download failed; rerun this same coordinator') from error
    require({p.name for p in destination.iterdir()} == {'task.json'}, 'Unexpected checkpoint files')
    path = destination / 'task.json'
    require(path.is_file() and not path.is_symlink() and path.stat().st_size < 1024 * 1024, 'Unsafe checkpoint')
    return json.loads(path.read_text(encoding='utf-8'))


class Checkpoints:
    def __init__(self, root, version, run_id, attempt, upload):
        self.root, self.prefix = root, artifact_prefix(version, run_id)
        require(re.fullmatch(r'[1-9][0-9]*', attempt or ''), 'Invalid service attempt')
        self.attempt, self.upload, self.revision, self.last = attempt, upload, 0, None

    def __call__(self, state):
        value = json.dumps(state, sort_keys=True)
        if value == self.last:
            return
        require(self.revision < 999999, 'Checkpoint revision exhausted')
        self.revision += 1
        path = self.root / f'checkpoint-{self.revision:06d}' / 'task.json'
        release.save(path, state)
        # MUST succeed before ReleaseTask sends a non-idempotent POST. In an
        # ambiguous upload, stop and let the authenticated next attempt restore.
        self.upload(self.prefix + self.attempt + f'-{self.revision:06d}', path)
        self.last = value


def advance_until_done(task, publish, *, timeout=14400, interval=30, sleep=time.sleep, clock=time.monotonic):
    deadline, failures, unknown_reads = clock() + timeout, 0, 0
    previous = None
    while True:
        try:
            confirm = task.state['version'] if publish and task.state['phase'] == 'awaiting_confirmation' else None
            phase = task.advance(confirm=confirm)
            failures = 0
        except release.TransportError:
            failures += 1
            require(failures <= 6, 'GitHub transport unavailable after bounded recovery; rerun this same service run')
            require(clock() < deadline, 'Coordinator deadline reached; resume this same run')
            sleep(min(60, 5 * 2 ** (failures - 1)))
            continue  # The durable state, including any uncertain intent, is unchanged.
        unknown_reads = unknown_reads + 1 if phase.endswith('_dispatch_unknown') else 0
        require(unknown_reads <= 6, 'Dispatch outcome remains unknown; inspect this run, never send the POST again')
        summary = json.dumps(release.view(task.state), sort_keys=True)
        if summary != previous:
            print(summary, flush=True)
            previous = summary
        if phase == 'published' or phase == 'awaiting_confirmation' and not publish:
            return phase
        require(clock() < deadline, 'Coordinator deadline reached; rerun this same service run')
        sleep(interval)


def main():
    try:
        env = os.environ
        version, scope, sha = env['RELEASE_VERSION'], env['RELEASE_SCOPE'], env['EXPECTED_SOURCE_SHA']
        require(env.get('GITHUB_ACTIONS') == 'true' and env.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Hosted runner only')
        require(env.get('GITHUB_REF') == 'refs/heads/master' and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'Master dispatch only')
        require(env.get('GITHUB_WORKFLOW_REF', '').startswith(env['GITHUB_REPOSITORY'] + '/.github/workflows/' + WORKFLOW + '@'), 'Wrong coordinator workflow')
        require(sha == env.get('GITHUB_SHA'), 'Master moved before coordinator dispatch; do not rebind the version')
        require(env['PUBLISH_AFTER_ACCEPTANCE'] in ('true', 'false'), 'Publication intent must be explicit')
        client = release.GitHub(env['GITHUB_REPOSITORY'])
        root = Path(env['RUNNER_TEMP']) / 'release-service'
        root.mkdir(mode=0o700, exist_ok=False)
        state = restore(client, root, version, env['GITHUB_RUN_ID'], sha)
        if state is None:
            state = release.new_task(client.repo, version, scope, sha,
                client.publisher_pin() if scope == release.contract.MACOS_SELFSIGNED_SCOPE else None, pipeline=True)
        require(state['version'] == version and state['scope'] == scope and state['source_sha'] == sha
                and state.get('pipeline') is True, 'Restored release identity changed')
        action = ROOT / '.github/actions/desktop-release-service/index.cjs'
        def upload(name, path):
            result = subprocess.run(['node', str(action), 'checkpoint', name, str(path)], check=False)
            require(result.returncode == 0, 'Checkpoint upload failed; no new dispatch will be sent')
        persist = Checkpoints(root, version, env['GITHUB_RUN_ID'], env['GITHUB_RUN_ATTEMPT'], upload)
        persist(state)
        task = release.ReleaseTask(client, state, persist)
        phase = advance_until_done(task, env['PUBLISH_AFTER_ACCEPTANCE'] == 'true')
        with open(env['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write(f'## Desktop {version}: {phase}\n\nSource: `{sha}`\n\n')
            for kind, intent in state['stages'].items():
                summary.write(f'- {kind}: https://github.com/{client.repo}/actions/runs/{intent["run_id"]}\n')
            if phase == 'published':
                summary.write(f'\nVerified release: https://github.com/{client.repo}/releases/tag/desktop-v{version}\n')
        return 0
    except (release.TaskError, ValueError, KeyError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
