#!/usr/bin/env python3
"""Idle prebuild regressions; offline, no dispatch, signing or Rust compilation."""
import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('idle', ROOT / 'scripts/desktop-candidate-idle.py')
i = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i)
old = i.c.module('idle_fakes', 'test-desktop-candidates.py')
SHA, OTHER, REPO = old.SHA, old.OTHER, old.REPO
NOW = datetime(2026, 10, 19, tzinfo=timezone.utc)
STAMP = (NOW - timedelta(minutes=20)).isoformat()
SCOPE = 'all-macos-preview'


def row(run_id=50, workflow=i.c.WORKFLOW, **kwargs):
    return {'id': run_id, 'head_sha': SHA, 'head_branch': 'master',
            'run_attempt': 1,
            'head_repository': {'full_name': REPO}, 'status': 'completed',
            'conclusion': 'success', 'event': 'schedule',
            'path': '.github/workflows/' + workflow, **kwargs}


class FakeGitHub(old.FakeGitHub):
    def __init__(self):
        super().__init__()
        self.cis[0]['updated_at'] = STAMP
        self.runs[1]['updated_at'] = STAMP
        self.controllers, self.builds, self.active, self.reads = [], [], [], []
    def jobs(self, run_id, attempt):
        if run_id not in self.job_rows and any(r['id'] == run_id for r in self.controllers):
            return [{'status': 'completed', 'conclusion': 'failure',
                     'steps': [{'name': i.PREPARE_STEP, 'status': 'completed', 'conclusion': 'failure'}]}]
        return super().jobs(run_id, attempt)
    def pages(self, path, field):
        self.reads.append(path)
        if path.startswith('actions/runs?status='):
            status = path.split('status=')[1].split('&')[0]
            return copy.deepcopy([r for r in self.active if r['status'] == status])
        if path.startswith('actions/workflows/desktop-candidates.yml/runs?'):
            return copy.deepcopy(self.controllers)
        if path.startswith('actions/workflows/desktop-release.yml/runs?'):
            return copy.deepcopy(self.builds)
        raise AssertionError(path)


class Selection(unittest.TestCase):
    def setUp(self):
        self.client = FakeGitHub()
    def select(self, trigger=None):
        result = i.select(self.client, SCOPE, SHA, '77', trigger, now=NOW)
        self.assertEqual(self.client.posts, [])
        self.assertEqual(self.client.creates, [])
        return result
    def test_idle_green_master_is_admitted_without_any_mutation(self):
        result = self.select()
        self.assertTrue(result['prepare'])
        self.assertFalse(result['published'])
        self.assertEqual(result['reason'], 'idle_green_master')
        self.assertEqual(result['ci'], old.old.ci())
    def test_master_movement_before_or_during_planning_defers(self):
        for masters in ([OTHER], [SHA, SHA, OTHER]):
            with self.subTest(masters=masters), patch.object(self.client, 'master', side_effect=masters):
                self.assertEqual(self.select()['reason'], 'master_moved')
    def test_no_ci_and_non_green_latest_ci_never_fall_back_to_old_green(self):
        self.client.cis = []
        self.assertEqual(self.select()['reason'], 'waiting_for_ci')
        for edits in ({'status': 'in_progress', 'conclusion': None}, {'conclusion': 'failure'},
                      {'conclusion': 'cancelled'}, {'conclusion': 'skipped'}):
            self.client.cis = [{**old.old.ci(), 'updated_at': STAMP}, {**old.old.ci(), 'id': 2, **edits}]
            self.assertFalse(self.select()['prepare'])
    def test_workflow_run_trigger_must_match_current_head_and_latest_attempt(self):
        for trigger in (('1', '1', OTHER), ('2', '1', SHA), ('1', '2', SHA), ('0', '1', SHA)):
            with self.subTest(trigger=trigger):
                self.assertEqual(self.select(trigger)['reason'], 'superseded_trigger')
        self.assertTrue(self.select(('1', '1', SHA))['prepare'])
    def test_fork_wrong_workflow_and_skipped_jobs_fail_closed(self):
        for edits in ({'head_repository': {'full_name': 'attacker/fork'}}, {'path': '.github/workflows/fake.yml'}):
            with self.subTest(edits=edits), patch.dict(self.client.runs[1], edits), self.assertRaises(ValueError):
                self.select()
        for conclusion in ('failure', 'skipped', 'neutral', None):
            self.client.job_rows[1] = [{'status': 'completed', 'conclusion': conclusion}]
            with self.subTest(conclusion=conclusion), self.assertRaises(ValueError): self.select()
    def test_ci_must_have_been_quiet_for_ten_minutes(self):
        for seconds in (0, 599, 600):
            self.client.cis[0]['updated_at'] = (NOW - timedelta(seconds=seconds)).isoformat()
            with self.subTest(seconds=seconds):
                self.assertEqual(self.select()['prepare'], seconds == 600)
        for stamp in (None, 'invalid', NOW.replace(tzinfo=None).isoformat(), (NOW + timedelta(seconds=1)).isoformat()):
            self.client.cis[0]['updated_at'] = stamp
            with self.subTest(stamp=stamp), self.assertRaises(ValueError): self.select()
    def test_every_active_state_defers_for_ci_and_release_work(self):
        for status in i.ACTIVE:
            for workflow in ('ci.yml', 'desktop-release.yml', 'desktop-promote.yml', 'installer-process-probe.yml'):
                self.client.active = [row(workflow=workflow, status=status, conclusion=None)]
                with self.subTest(status=status, workflow=workflow):
                    result = self.select()
                    self.assertEqual(result['reason'], 'repository_busy')
                    self.assertEqual(result['related_run_id'], 50)
    def test_unrelated_stalled_queue_does_not_starve_releases_but_running_work_defers(self):
        for status in i.ACTIVE:
            self.client.active = [row(workflow='mirror-to-gitee.yml', status=status, conclusion=None)]
            with self.subTest(status=status):
                self.assertEqual(self.select()['prepare'], status != 'in_progress')
    def test_own_controller_and_queued_controllers_do_not_deadlock_admission(self):
        self.client.active = [row(77, status='in_progress'), row(78, status='queued')]
        self.client.controllers = copy.deepcopy(self.client.active)
        self.assertTrue(self.select()['prepare'])
    def test_busy_work_appearing_during_planning_defers_before_allocation(self):
        with patch.object(i, 'busy_run', side_effect=[None, 93]):
            result = self.select()
        self.assertEqual(result['reason'], 'repository_busy')
        self.assertEqual(result['related_run_id'], 93)
    def test_failed_uncertain_or_running_controller_requires_same_run_recovery(self):
        for edits in ({'status': 'in_progress', 'conclusion': None},
                      *({'conclusion': v} for v in ('failure', 'cancelled', 'timed_out', 'neutral', None))):
            self.client.controllers = [row(**edits)]
            with self.subTest(edits=edits):
                result = self.select()
                self.assertFalse(result['prepare'])
                self.assertEqual(result['reason'], 'resume_existing_controller')
    def test_successful_deferred_controller_does_not_suppress_later_prebuild(self):
        self.client.controllers = [row()]
        self.assertTrue(self.select()['prepare'])
    def test_cancelled_pending_or_failed_pre_admission_run_does_not_poison_source(self):
        self.client.controllers = [row(conclusion='cancelled')]
        for jobs in ([], [{'status': 'completed', 'conclusion': 'cancelled', 'steps': []}],
                     [{'status': 'completed', 'conclusion': 'failure',
                       'steps': [{'name': i.PREPARE_STEP, 'status': 'completed', 'conclusion': 'skipped'}]}]):
            self.client.job_rows[50] = jobs
            with self.subTest(jobs=jobs): self.assertTrue(self.select()['prepare'])
    def test_missing_mutation_step_evidence_is_not_permission_to_start_another_version(self):
        self.client.controllers = [row(conclusion='failure')]
        for jobs in ([], [{'status': 'completed', 'conclusion': 'failure'}],
                     [{'status': 'completed', 'conclusion': 'failure',
                       'steps': [{'name': 'unexpected step', 'conclusion': 'success'}]}]):
            self.client.job_rows[50] = jobs
            with self.subTest(jobs=jobs), self.assertRaises(ValueError): self.select()
    def test_ready_build_reuses_exact_policy_and_never_downloads_packages(self):
        self.client.builds = [row(42, 'desktop-release.yml', event='workflow_dispatch', head_branch='desktop-v0.2.20')]
        with patch.object(i.c, 'reuse_task') as reuse:
            result = self.select()
        reuse.assert_called_once_with(self.client, '42', '0.2.20', SCOPE)
        self.assertFalse(result['prepare'])
        self.assertEqual(result['reason'], 'candidate_ready')
        self.assertEqual(result['version'], '0.2.20')
    def test_newest_failed_build_is_not_hidden_by_older_successful_candidate(self):
        for edits in ({'conclusion': 'failure'}, {'conclusion': 'cancelled'},
                      {'status': 'in_progress', 'conclusion': None}):
            self.client.builds = [row(41, 'desktop-release.yml', event='workflow_dispatch', head_branch='desktop-v0.2.19'),
                                 row(42, 'desktop-release.yml', event='workflow_dispatch', head_branch='desktop-v0.2.20', **edits)]
            with self.subTest(edits=edits), patch.object(i.c, 'reuse_task') as reuse:
                self.assertEqual(self.select()['reason'], 'inspect_existing_build')
            reuse.assert_not_called()
    def test_changed_ci_scope_pin_expired_or_missing_evidence_does_not_rebuild(self):
        self.client.builds = [row(42, 'desktop-release.yml', event='workflow_dispatch', head_branch='desktop-v0.2.20')]
        for failure in ('CI reran', 'Scope mismatch', 'Publisher changed', 'Expired artifact', 'Missing plan'):
            with self.subTest(failure=failure), patch.object(i.c, 'reuse_task', side_effect=ValueError(failure)):
                self.assertEqual(self.select()['reason'], 'candidate_evidence_changed')
    def test_transient_reads_are_not_mislabelled_as_candidate_failure(self):
        self.client.builds = [row(42, 'desktop-release.yml', event='workflow_dispatch', head_branch='desktop-v0.2.20')]
        with patch.object(i.c, 'reuse_task', side_effect=i.c.release.TransportError('read failed')), \
                self.assertRaises(i.c.release.TransportError): self.select()
        self.client.builds = []
        with patch.object(self.client, 'pages', side_effect=i.c.release.TransportError('read failed')), \
                self.assertRaises(i.c.release.TransportError): self.select()
    def test_manual_master_build_is_not_misrepresented_as_immutable_candidate(self):
        self.client.builds = [row(42, 'desktop-release.yml', event='workflow_dispatch')]
        with patch.object(i.c, 'reuse_task') as reuse:
            self.assertTrue(self.select()['prepare'])
        reuse.assert_not_called()
    def test_wrong_history_identity_cannot_be_trusted(self):
        for edits in ({'head_sha': OTHER}, {'head_repository': {'full_name': 'attacker/fork'}},
                      {'path': '.github/workflows/ci.yml'}, {'event': 'pull_request'}, {'head_branch': 'topic'},
                      {'id': '50\nmalicious'}, {'id': True}):
            self.client.controllers = [row(**edits)]
            with self.subTest(edits=edits), self.assertRaises(ValueError): self.select()
    def test_truncated_history_or_busy_search_cannot_prove_absence(self):
        self.client.controllers = [row(n) for n in range(1001, 2001)]
        with self.assertRaisesRegex(ValueError, 'history limit'): self.select()
        self.client.controllers = []
        self.client.active = [row(n, 'ci.yml', status='queued') for n in range(1, 1001)]
        with self.assertRaisesRegex(ValueError, 'search limit'): self.select()
    def test_ci_changes_during_planning_cannot_be_rebound(self):
        original = i.c.eligible_ci
        calls = []
        def eligible(*args):
            calls.append(1)
            if len(calls) == 2:
                self.client.cis[0]['run_attempt'] = 2
            return original(*args)
        with patch.object(i.c, 'eligible_ci', side_effect=eligible), self.assertRaises(ValueError): self.select()
    def test_scope_source_and_controller_id_are_validated_before_reads(self):
        for scope, sha, own in (('windows-linux', SHA, '77'), (SCOPE, 'HEAD', '77'), (SCOPE, SHA, '../77')):
            with self.subTest(scope=scope, sha=sha, own=own), self.assertRaises(ValueError):
                i.select(self.client, scope, sha, own, now=NOW)
        self.assertEqual(self.client.reads, [])


class Hosted(unittest.TestCase):
    def env(self, folder):
        return dict(GITHUB_ACTIONS='true', RUNNER_ENVIRONMENT='github-hosted', GITHUB_REF='refs/heads/master',
                    GITHUB_EVENT_NAME='schedule', GITHUB_REPOSITORY=REPO, GITHUB_SHA=SHA,
                    GITHUB_WORKFLOW_REF=REPO + '/.github/workflows/desktop-candidates.yml@refs/heads/master',
                    RELEASE_SCOPE=SCOPE, XHARNESS_FRIENDS_RELEASE_REPOSITORY=REPO,
                    RUNNER_TEMP=folder, GITHUB_RUN_ID='77', GITHUB_RUN_ATTEMPT='1',
                    GITHUB_OUTPUT=str(Path(folder) / 'output'), GITHUB_STEP_SUMMARY=str(Path(folder) / 'summary'))
    def test_schedule_manual_and_ci_triggers_use_same_read_only_admission(self):
        for event in ('schedule', 'workflow_dispatch', 'workflow_run'):
            with self.subTest(event=event), tempfile.TemporaryDirectory() as folder:
                env = self.env(folder)
                env.update(GITHUB_EVENT_NAME=event, TRIGGER_CI_RUN_ID='1', TRIGGER_CI_ATTEMPT='1', TRIGGER_SOURCE_SHA=SHA)
                result = i.decision('idle_green_master', SHA, old.old.ci(), prepare=True)
                with patch.object(i.c, 'CandidateGitHub', return_value=FakeGitHub()), \
                        patch.object(i, 'select', return_value=result) as select:
                    self.assertEqual(i.hosted(env), result)
                self.assertEqual(select.call_args.args[-1], ('1', '1', SHA) if event == 'workflow_run' else None)
                self.assertIn('prepare=true\n', Path(env['GITHUB_OUTPUT']).read_text())
    def test_rerun_restores_old_source_before_idle_selection_even_when_master_moves(self):
        with tempfile.TemporaryDirectory() as folder:
            env = self.env(folder); env.update(GITHUB_SHA=OTHER, GITHUB_RUN_ATTEMPT='2')
            client = FakeGitHub(); client.sha = OTHER
            state = old.journal()
            with patch.dict(os.environ, env, clear=True), patch.object(i.c, 'CandidateGitHub', return_value=client), \
                    patch.object(i.c.service, 'restore_checkpoint', return_value=state) as restore, \
                    patch.object(i, 'select') as select:
                result = i.hosted(env)
            self.assertTrue(result['prepare'])
            self.assertEqual(result['source_sha'], SHA)
            self.assertEqual(result['reason'], 'resume_same_journal')
            self.assertEqual(restore.call_args.args[-1], OTHER)
            select.assert_not_called()
            self.assertEqual(client.posts, [])
    def test_rerun_without_journal_changed_policy_or_changed_ci_cannot_start_afresh(self):
        for change in ('missing', 'scope', 'ci', 'publication'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as folder:
                env = self.env(folder); env['GITHUB_RUN_ATTEMPT'] = '2'
                client, state = FakeGitHub(), old.journal()
                if change == 'scope': state['scope'] = 'all'
                if change == 'ci': client.cis[0]['run_attempt'] = 2
                if change == 'publication':
                    i.c.reserve(client, state, lambda _: None)
                    state['task']['stages']['publish'] = {}
                client.creates = []
                with patch.object(i.c, 'CandidateGitHub', return_value=client), \
                        patch.object(i.c.service, 'restore_checkpoint', return_value=None if change == 'missing' else state), \
                        patch.object(i, 'select') as select, self.assertRaises(ValueError):
                    i.hosted(env)
                select.assert_not_called()
                self.assertEqual(client.posts, []); self.assertEqual(client.creates, [])
    def test_untrusted_context_fails_before_network_output_or_artifacts(self):
        for key, value in (('GITHUB_ACTIONS', 'false'), ('RUNNER_ENVIRONMENT', 'self-hosted'),
                           ('GITHUB_REF', 'refs/heads/topic'), ('GITHUB_EVENT_NAME', 'pull_request_target'),
                           ('GITHUB_WORKFLOW_REF', REPO + '/.github/workflows/ci.yml@refs/heads/master'),
                           ('GITHUB_SHA', 'HEAD'), ('GITHUB_RUN_ID', '0'), ('GITHUB_RUN_ATTEMPT', '0'),
                           ('RELEASE_SCOPE', 'windows-linux')):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as folder:
                env = self.env(folder); env[key] = value
                with patch.object(i.c, 'CandidateGitHub') as client, self.assertRaises(ValueError): i.hosted(env)
                client.assert_not_called()
                self.assertEqual(list(Path(folder).iterdir()), [])
    def test_ready_summary_exposes_existing_promotion_only_entry(self):
        with tempfile.TemporaryDirectory() as folder:
            env = self.env(folder)
            result = i.decision('candidate_ready', SHA, old.old.ci(), run_id=42, version='0.2.20')
            i.write_result(env, REPO, result)
            self.assertEqual(json.loads((Path(folder) / 'desktop-candidate-idle.json').read_text()), result)
            self.assertIn('--candidate-run-id 42 --confirm-publish 0.2.20', Path(env['GITHUB_STEP_SUMMARY']).read_text())
            self.assertIn('prepare=false\n', Path(env['GITHUB_OUTPUT']).read_text())
    def test_admission_to_real_coordinator_prepares_four_platforms_then_stops(self):
        for event in ('schedule', 'workflow_dispatch', 'workflow_run'):
            with self.subTest(event=event), tempfile.TemporaryDirectory() as folder:
                client, env = FakeGitHub(), self.env(folder)
                env.update(GITHUB_EVENT_NAME=event, TRIGGER_CI_RUN_ID='1', TRIGGER_CI_ATTEMPT='1', TRIGGER_SOURCE_SHA=SHA)
                selected = i.select(client, SCOPE, SHA, '77', now=NOW)
                self.assertTrue(selected['prepare'])
                def advance(task, publish):
                    self.assertFalse(publish)
                    self.assertEqual(task.advance(), 'build_running')
                    intent = task.state['stages']['build']
                    client.runs[intent['run_id']].update(status='completed', conclusion='success')
                    return task.advance()
                with patch.dict(os.environ, env, clear=True), patch.object(i.c, 'CandidateGitHub', return_value=client), \
                        patch.object(i.c.service, 'restore_checkpoint', return_value=None), \
                        patch.object(i.c.service, 'advance_until_done', side_effect=advance), \
                        patch.object(i.c.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
                    self.assertEqual(i.c.main(), 0)
                ready = json.loads((Path(folder) / 'desktop-candidate-prepare/ready.json').read_text())
                self.assertEqual(ready['source_sha'], SHA)
                self.assertEqual(ready['ci'], selected['ci'])
                self.assertFalse(ready['published'])
                self.assertEqual(len(client.creates), 1)
                self.assertEqual([name for name, _ in client.posts], ['desktop-release.yml'])
                self.assertTrue(client.posts[0][1]['integrated_acceptance'])
    def test_master_movement_after_admission_cannot_allocate(self):
        with tempfile.TemporaryDirectory() as folder:
            client, env = FakeGitHub(), self.env(folder)
            env.update(TRIGGER_SOURCE_SHA=SHA, TRIGGER_CI_RUN_ID='1', TRIGGER_CI_ATTEMPT='1')
            client.sha = OTHER
            with patch.dict(os.environ, env, clear=True), patch.object(i.c, 'CandidateGitHub', return_value=client), \
                    patch.object(i.c.service, 'restore_checkpoint', return_value=None), patch('sys.stderr'):
                self.assertEqual(i.c.main(), 2)
            self.assertEqual(client.creates, []); self.assertEqual(client.posts, [])


class Workflow(unittest.TestCase):
    def test_idle_gate_precedes_sdk_and_all_expensive_mutations_are_conditional(self):
        text = (ROOT / '.github/workflows/desktop-candidates.yml').read_text()
        self.assertIn("cron: '17,47 * * * *'", text)
        self.assertIn('workflow_dispatch:', text)
        self.assertIn('group: desktop-candidate-prepare-idle', text)
        self.assertIn('cancel-in-progress: false', text)
        self.assertLess(text.index('scripts/desktop-candidate-idle.py'), text.index('actions/setup-node@'))
        self.assertIn('id: idle\n        timeout-minutes: 5\n', text)
        self.assertEqual(text.count('- name: ' + i.PREPARE_STEP), 1)
        self.assertEqual(text.count("if: steps.idle.outputs.prepare == 'true'"), 3)
        self.assertIn("if: success() && steps.idle.outputs.prepare == 'true'", text)
        for name in ('ci.yml', 'desktop-release.yml'):
            self.assertIn('scripts/test-desktop-candidate-idle.py', (ROOT / '.github/workflows' / name).read_text())
        for forbidden in ('continue-on-error', 'pull_request_target', 'confirm-publish:', 'PRIVATE_KEY'):
            self.assertNotIn(forbidden, text)


if __name__ == '__main__':
    unittest.main()
