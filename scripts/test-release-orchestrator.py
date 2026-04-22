#!/usr/bin/env python3
"""Offline release-task tests: no GitHub writes, keys, models or Rust compilation."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


release = module('orchestrator', 'release.py')
build = module('builder', 'desktop-release-build.py')
SHA, OTHER, REPO = 'a' * 40, 'b' * 40, 'owner/project'


def ci():
    return dict(id=1, run_attempt=1, head_sha=SHA, head_branch='master', event='push',
                status='completed', conclusion='success', path='.github/workflows/ci.yml')


class FakeGitHub:
    repo = REPO
    def __init__(self):
        self.sha = SHA; self.opt = True; self.cis = [ci()]; self.published = []
        self.runs = {}; self.posts = []; self.hidden = False; self.unknown = None
        self.job_rows = {}; self.on_dispatch = None
    def master(self): return self.sha
    def opted_in(self): return self.opt
    def ci(self, sha): return copy.deepcopy(self.cis)
    def releases(self): return copy.deepcopy(self.published)
    def jobs(self, run_id, attempt):
        return self.job_rows.get(run_id, [{'status': 'completed', 'conclusion': 'success'}])
    def dispatch(self, workflow, inputs):
        if self.on_dispatch: self.on_dispatch(workflow, inputs)
        self.posts.append((workflow, copy.deepcopy(inputs)))
        if self.unknown == 'before': raise release.TransportError('offline before send')
        run_id = 10 + len(self.runs)
        self.runs[run_id] = dict(id=run_id, run_attempt=1, head_sha=self.sha,
            head_branch='master', event='workflow_dispatch', status='queued', conclusion=None,
            path='.github/workflows/' + workflow, head_repository={'full_name': REPO},
            display_title='release-task ' + inputs['orchestration_id'])
        if self.unknown == 'after': raise release.TransportError('reply lost')
    def run(self, run_id): return copy.deepcopy(self.runs[run_id])
    def find(self, workflow, intent):
        return [] if self.hidden else [copy.deepcopy(r) for r in self.runs.values()
                                       if r['display_title'] == 'release-task ' + intent['token']]


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeGitHub()
        self.saved = []
        self.state = release.new_task(REPO, '0.2.20', 'all-macos-preview', SHA)
        self.task = release.ReleaseTask(self.client, self.state, lambda s: self.saved.append(copy.deepcopy(s)))
    def complete(self, name, conclusion='success'):
        intent = self.state['stages'][name]
        run = next(r for r in self.client.runs.values() if r['display_title'].endswith(intent['token']))
        run.update(status='completed', conclusion=conclusion)
        return run
    def ready(self):
        self.task.advance(); self.complete('build'); self.task.advance()
        self.complete('unix'); self.complete('windows')
        self.assertEqual(self.task.advance(), 'awaiting_confirmation')

    def test_entire_task_stops_before_publish_then_confirms_once(self):
        self.ready()
        for _ in range(5): self.task.advance()
        self.assertEqual(len(self.client.posts), 3)
        build_id = str(self.state['stages']['build']['run_id'])
        self.assertEqual(self.client.posts[1][1]['release_run_id'], build_id)
        self.assertEqual(self.client.posts[1][1]['mode'], 'candidate')
        self.assertEqual(self.client.posts[2][1]['release_run_id'], build_id)
        self.task.advance(confirm='0.2.20')
        self.assertEqual(len(self.client.posts), 4)
        self.complete('publish')
        self.assertEqual(self.task.advance(), 'published')
        self.assertEqual(self.task.advance(), 'published')
        self.assertEqual(len(self.client.posts), 4)

    def test_intent_is_durable_before_post(self):
        def check(workflow, inputs):
            self.assertEqual(self.saved[-1]['stages']['build']['token'], inputs['orchestration_id'])
            self.assertEqual(self.saved[-1]['stages']['build']['dispatch'], 'unknown')
        self.client.on_dispatch = check
        self.task.advance()

    def test_cli_crash_and_resume_does_not_dispatch_twice(self):
        self.task.advance()
        saved = copy.deepcopy(self.state)
        resumed = release.ReleaseTask(self.client, saved, lambda _: None)
        resumed.advance()
        self.assertEqual(len(self.client.posts), 1)

    def test_unknown_dispatch_reply_is_recovered_by_correlation(self):
        self.client.unknown = 'after'
        self.assertEqual(self.task.advance(), 'build_dispatch_unknown')
        self.client.unknown = None
        self.task.advance(retry=True)
        self.assertEqual(len(self.client.posts), 1)
        self.assertEqual(self.state['stages']['build']['run_id'], 10)

    def test_unknown_unobserved_dispatch_is_never_blindly_retried(self):
        self.client.unknown = 'before'
        self.task.advance()
        for _ in range(10): self.task.advance(retry=True)
        self.assertEqual(len(self.client.posts), 1)
        self.assertEqual(self.state['phase'], 'build_dispatch_unknown')

    def test_delayed_visibility_does_not_trigger_duplicate(self):
        self.client.hidden = True
        self.task.advance()
        for _ in range(8): self.task.advance()
        self.assertEqual(len(self.client.posts), 1)
        self.client.hidden = False; self.task.advance()
        self.assertEqual(self.state['stages']['build']['run_id'], 10)

    def test_duplicate_correlated_runs_fail_closed(self):
        self.client.hidden = True; self.task.advance()
        self.client.runs[11] = {**self.client.runs[10], 'id': 11}
        self.client.hidden = False
        with self.assertRaisesRegex(release.TaskError, 'duplicate'): self.task.advance()

    def test_source_movement_before_build_fails_without_mutation(self):
        self.client.sha = OTHER
        with self.assertRaisesRegex(release.TaskError, 'master changed'): self.task.advance()
        self.assertEqual(self.client.posts, [])

    def test_source_movement_during_build_dispatch_is_rejected(self):
        self.client.on_dispatch = lambda *_: setattr(self.client, 'sha', OTHER)
        with self.assertRaisesRegex(release.TaskError, 'master moved'): self.task.advance()
        self.assertEqual(len(self.client.posts), 1)

    def test_new_master_control_workflows_may_validate_the_pinned_candidate(self):
        self.task.advance(); self.complete('build'); self.client.sha = OTHER
        self.task.advance(); self.complete('unix'); self.complete('windows')
        self.assertEqual(self.task.advance(), 'awaiting_confirmation')
        self.assertEqual(self.state['source_sha'], SHA)

    def test_running_and_failed_latest_ci_never_builds(self):
        self.client.cis[0]['status'] = 'in_progress'
        self.assertEqual(self.task.advance(), 'waiting_ci')
        self.client.cis = [ci(), {**ci(), 'id': 2, 'conclusion': 'failure'}]
        with self.assertRaises(ValueError): self.task.advance()
        self.assertEqual(self.client.posts, [])

    def test_non_passing_ci_job_blocks(self):
        self.client.job_rows[1] = [{'status': 'completed', 'conclusion': 'skipped'}]
        with self.assertRaisesRegex(release.TaskError, 'non-passing'): self.task.advance()
        self.assertEqual(self.client.posts, [])

    def test_unknown_repository_opt_in_blocks(self):
        self.client.opt = False
        with self.assertRaisesRegex(release.TaskError, 'opted'): self.task.advance()
        self.assertEqual(self.client.posts, [])

    def test_existing_or_older_release_never_replaced(self):
        for version, draft in [('0.2.20', True), ('0.2.20', False), ('0.2.21', False)]:
            self.client.published = [dict(tag_name='desktop-v'+version, draft=draft)]
            with self.assertRaises(ValueError): self.task.advance()
        self.assertEqual(self.client.posts, [])

    def test_faulted_stage_cannot_be_used_as_evidence(self):
        for conclusion in ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral']:
            with self.subTest(conclusion=conclusion):
                self.setUp(); self.task.advance(); self.complete('build', conclusion)
                with self.assertRaises(release.TaskError): self.task.advance()
                self.assertNotIn('unix', self.state['stages'])

    def test_success_run_with_skipped_job_is_not_accepted(self):
        self.task.advance(); run = self.complete('build')
        self.client.job_rows[run['id']] = [{'status': 'completed', 'conclusion': 'skipped'}]
        with self.assertRaisesRegex(release.TaskError, 'every required job'): self.task.advance()

    def test_verified_attempt_rerun_invalidates_downstream(self):
        self.ready(); self.client.runs[10]['run_attempt'] += 1
        with self.assertRaisesRegex(release.TaskError, 'rerun'): self.task.advance(confirm='0.2.20')
        self.assertEqual(len(self.client.posts), 3)

    def test_wrong_version_or_early_confirmation_never_publishes(self):
        with self.assertRaisesRegex(release.TaskError, 'First finish'): self.task.advance(confirm='0.2.20')
        self.ready()
        with self.assertRaisesRegex(release.TaskError, 'exactly match'): self.task.advance(confirm='0.2.21')
        self.assertEqual(len(self.client.posts), 3)

    def test_retry_known_failed_acceptance_only(self):
        self.task.advance(); self.complete('build'); self.task.advance()
        self.complete('unix', 'failure'); self.complete('windows')
        with self.assertRaises(release.TaskError): self.task.advance()
        self.task.advance(retry=True)
        self.assertEqual(len(self.client.posts), 4)
        self.assertEqual(self.client.posts[-1][0], 'desktop-unix-update-acceptance.yml')
        self.complete('unix')
        self.assertEqual(self.task.advance(), 'awaiting_confirmation')
        self.assertEqual(len(self.state['history']), 1)

    def test_failed_build_with_existing_draft_is_not_retried(self):
        self.task.advance(); self.complete('build', 'failure')
        self.client.published = [dict(tag_name='desktop-v0.2.20', draft=True)]
        with self.assertRaisesRegex(release.TaskError, 'already exists'): self.task.advance(retry=True)
        self.assertEqual(len(self.client.posts), 1)

    def test_failed_publication_with_visible_release_is_not_retried(self):
        self.ready(); self.task.advance(confirm='0.2.20'); self.complete('publish', 'failure')
        self.client.published = [dict(tag_name='desktop-v0.2.20', draft=False)]
        with self.assertRaisesRegex(release.TaskError, 'already exists'): self.task.advance(retry=True)
        self.assertEqual(len(self.client.posts), 4)

    def test_status_never_dispatches_missing_next_stage(self):
        self.task.advance(dispatch=False); self.assertEqual(self.client.posts, [])
        self.task.advance(); self.complete('build')
        self.task.advance(dispatch=False)
        self.assertEqual(len(self.client.posts), 1)

    def test_provenance_rejects_wrong_workflow_repository_event_branch_token(self):
        variants = [('path', '.github/workflows/ci.yml'), ('event', 'push'), ('head_branch', 'topic'),
                    ('head_repository', {'full_name': 'other/repo'}), ('display_title', 'wrong')]
        for key, value in variants:
            with self.subTest(key=key):
                self.setUp(); self.task.advance(); self.client.runs[10][key] = value
                with self.assertRaisesRegex(release.TaskError, 'provenance'): self.task.advance()

    def test_scope_changes_on_resume_cannot_mix_candidates(self):
        self.task.advance(); self.state['scope'] = 'all'
        with self.assertRaisesRegex(release.TaskError, 'inputs changed'): self.task.advance()


class CommandTests(unittest.TestCase):
    def test_dispatch_uses_master_and_json_boolean_without_shell(self):
        result = subprocess.CompletedProcess([], 0, '', '')
        with patch.object(release.subprocess, 'run', return_value=result) as run:
            release.GitHub(REPO).dispatch('desktop-release.yml', {'prepare_tag': True})
        args, kwargs = run.call_args
        self.assertEqual(args[0], ['gh', 'api', '--method', 'POST',
                                 'repos/owner/project/actions/workflows/desktop-release.yml/dispatches', '--input', '-'])
        self.assertEqual(json.loads(kwargs['input']), {'ref': 'master', 'inputs': {'prepare_tag': True}})
        self.assertNotIn('shell', kwargs)
        self.assertEqual(kwargs['timeout'], 90)

    def test_transport_error_does_not_expose_cli_stderr(self):
        result = subprocess.CompletedProcess([], 1, '', 'sensitive CLI details')
        with patch.object(release.subprocess, 'run', return_value=result):
            with self.assertRaises(release.TransportError) as error:
                release.gh(['api', 'anything'])
        self.assertNotIn('sensitive', str(error.exception))

    def test_cli_status_missing_task_never_starts_one(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(release, 'GitHub') as client, \
                patch.object(sys, 'argv', ['release.py', '0.2.20', '--repo', REPO, '--state-dir', directory, '--status']), \
                patch('sys.stderr'):
            self.assertEqual(release.main(), 2)
            client.return_value.master.assert_not_called()
            client.return_value.dispatch.assert_not_called()
            self.assertEqual(list(Path(directory).rglob('*.json')), [])

    def test_cli_status_rejects_mutation_flags_before_network(self):
        for extra in [['--retry'], ['--confirm-publish', '0.2.20']]:
            with patch.object(sys, 'argv', ['release.py', '0.2.20', '--status', *extra]), \
                    patch.object(release, 'gh') as gh, patch('sys.stderr'):
                self.assertEqual(release.main(), 2)
                gh.assert_not_called()


class PersistenceTests(unittest.TestCase):
    def test_atomic_save_roundtrip_and_no_temp_files(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'task.json'
            release.save(path, {'text': '界🙂'}); release.save(path, {'text': 'updated'})
            self.assertEqual(json.loads(path.read_text()), {'text': 'updated'})
            self.assertEqual([p.name for p in Path(folder).iterdir()], ['task.json'])

    def test_failed_replace_preserves_previous_state(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'task.json'; release.save(path, {'old': True})
            with patch.object(release.os, 'replace', side_effect=OSError('injected')):
                with self.assertRaises(OSError): release.save(path, {'new': True})
            self.assertEqual(json.loads(path.read_text()), {'old': True})
            self.assertEqual(len(list(Path(folder).iterdir())), 1)

    def test_os_lock_excludes_other_process_and_recovers_after_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'task.json'
            code = f"import runpy; m=runpy.run_path({str(ROOT / 'scripts/release.py')!r}); c=m['task_lock']({str(path)!r}); c.__enter__(); print('locked')"
            with release.task_lock(path):
                other = subprocess.run([sys.executable, '-B', '-c', code], capture_output=True, text=True)
                self.assertNotEqual(other.returncode, 0)
                self.assertIn('already running', other.stderr)
            other = subprocess.run([sys.executable, '-B', '-c', code], capture_output=True, text=True)
            self.assertEqual(other.returncode, 0, other.stderr)
            with release.task_lock(path): pass


class WorkflowAndTagTests(unittest.TestCase):
    def test_all_existing_workflows_accept_the_same_correlation_key(self):
        for file in release.WORKFLOWS.values():
            text = (ROOT / '.github/workflows' / file).read_text()
            self.assertIn('      orchestration_id:', text)
            self.assertIn("format('release-task {0}', inputs.orchestration_id)", text)
        ci_text = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn('python -B scripts/test-release-orchestrator.py', ci_text)
        self.assertIn('os: [ubuntu-latest, windows-2025, macos-15]', ci_text)

    def test_prepare_tag_locks_sha_checks_ci_and_does_not_force_refs(self):
        environment = dict(GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REF='refs/heads/master',
                           EXPECTED_SOURCE_SHA=SHA, GITHUB_SHA=SHA, RELEASE_TAG_INPUT='desktop-v0.2.20',
                           GITHUB_RUN_ID='5', GITHUB_RUN_ATTEMPT='1', RELEASE_SCOPE_INPUT='all-macos-preview')
        with patch.dict(os.environ, environment), patch.object(build, 'trusted_checkout', return_value=(REPO, SHA)), \
                patch.object(build._contract, 'fetch_ci', return_value=[ci()]), \
                patch.object(build, 'api', return_value=[]), patch.object(build, 'verify_tag') as verify, \
                patch.object(build, 'run', side_effect=['[[]]', None]) as run:
            build.prepare_tag()
            self.assertIn('POST', run.call_args.args)
            self.assertIn('sha=' + SHA, run.call_args.args)
            self.assertNotIn('PATCH', run.call_args.args)
            verify.assert_called_once_with(REPO, 'desktop-v0.2.20', SHA)
        for changes in [dict(EXPECTED_SOURCE_SHA=OTHER), dict(GITHUB_EVENT_NAME='push'), dict(GITHUB_REF='refs/heads/topic')]:
            with patch.dict(os.environ, {**environment, **changes}), patch.object(build, 'trusted_checkout', return_value=(REPO, SHA)), patch.object(build, 'run') as run:
                with self.assertRaises(ValueError): build.prepare_tag()
                run.assert_not_called()

    def test_existing_tag_is_verified_never_recreated(self):
        environment = dict(GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REF='refs/heads/master', EXPECTED_SOURCE_SHA=SHA,
                           GITHUB_SHA=SHA, RELEASE_TAG_INPUT='desktop-v0.2.20', GITHUB_RUN_ID='5', GITHUB_RUN_ATTEMPT='1')
        with patch.dict(os.environ, environment), patch.object(build, 'trusted_checkout', return_value=(REPO, SHA)), \
                patch.object(build._contract, 'fetch_ci', return_value=[ci()]), \
                patch.object(build, 'api', return_value=[{'ref':'refs/tags/desktop-v0.2.20'}]), \
                patch.object(build, 'verify_tag') as verify, patch.object(build, 'run', return_value='[[]]') as run:
            build.prepare_tag(); self.assertEqual(run.call_count, 1); verify.assert_called_once()


if __name__ == '__main__': unittest.main()
