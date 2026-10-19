#!/usr/bin/env python3
"""Offline candidate trigger/allocation/reuse regression; no writes or Rust."""
import copy
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


c = module('candidates', 'desktop-candidates.py')
old = module('old_candidate_tests', 'test-release-orchestrator.py')
SHA, OTHER, REPO = old.SHA, old.OTHER, old.REPO


class FakeGitHub(old.FakeGitHub):
    def __init__(self):
        super().__init__()
        self.tags, self.creates = {}, []
        self.tag_outcome = 'accepted'
        self.runs[1] = {**old.ci(), 'head_repository': {'full_name': REPO}, 'display_title': 'CI'}
    def refs(self):
        return copy.deepcopy(list(self.tags.values()))
    def tag(self, tag):
        return copy.deepcopy(self.tags.get(tag))
    def create_tag(self, tag, sha):
        self.creates.append((tag, sha))
        if self.tag_outcome == 'accepted':
            self.tags[tag] = {'ref': 'refs/tags/' + tag, 'object': {'type': 'commit', 'sha': sha}}
        return self.tag_outcome
    def get(self, path):
        if path.startswith('compare/'):
            return {'status': 'ahead'}
        raise AssertionError(path)
    def publisher_pin(self):
        return 'c' * 40
    def dispatch(self, workflow, inputs, *, ref='master'):
        super().dispatch(workflow, inputs)
        if ref != 'master':
            self.runs[max(self.runs)].update(head_branch=ref, head_sha=SHA)
            self.job_rows[max(self.runs)] = [{'name': 'Signed ' + p + ' candidate', 'status': 'completed', 'conclusion': 'success'}
                                            for p in c.build.PLATFORMS]


def journal():
    return {'schema': 1, 'kind': 'automatic-candidate', 'repository': REPO, 'source_sha': SHA,
            'ci': old.ci(), 'scope': 'all-macos-preview', 'publisher_pin': None, 'allocations': []}


class Trigger(unittest.TestCase):
    def test_exact_green_master_ci_and_ancestor_after_master_moves(self):
        client = FakeGitHub()
        self.assertEqual(c.eligible_ci(client, '1', '1', SHA), old.ci())
        client.sha = OTHER
        self.assertEqual(c.eligible_ci(client, '1', '1', SHA), old.ci())

    def test_forged_failed_pr_fork_or_newer_attempt_never_allocates(self):
        for key, value in [('event', 'pull_request'), ('head_branch', 'topic'), ('head_sha', OTHER),
                           ('path', '.github/workflows/other.yml'), ('conclusion', 'failure'),
                           ('status', 'in_progress'), ('run_attempt', 2),
                           ('head_repository', {'full_name': 'attacker/fork'})]:
            client = FakeGitHub(); client.runs[1][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                c.eligible_ci(client, '1', '1', SHA)
            self.assertEqual(client.creates, [])
        client = FakeGitHub(); client.cis.append({**old.ci(), 'id': 2})
        with self.assertRaises(ValueError): c.eligible_ci(client, '1', '1', SHA)

    def test_any_nonpassing_master_job_or_diverged_source_rejected(self):
        for conclusion in ('failure', 'skipped', 'cancelled', 'neutral', None):
            client = FakeGitHub(); client.job_rows[1] = [{'status': 'completed', 'conclusion': conclusion}]
            with self.subTest(conclusion=conclusion), self.assertRaises(ValueError):
                c.eligible_ci(client, '1', '1', SHA)
        client = FakeGitHub(); client.sha = OTHER
        with patch.object(client, 'get', return_value={'status': 'diverged'}), self.assertRaises(ValueError):
            c.eligible_ci(client, '1', '1', SHA)

    def test_input_ids_are_strict(self):
        for ids in [('0', '1', SHA), ('1', '0', SHA), ('../1', '1', SHA), ('1', '1', 'HEAD')]:
            with self.subTest(ids=ids), self.assertRaises(ValueError): c.eligible_ci(FakeGitHub(), *ids)


class Allocation(unittest.TestCase):
    def test_versions_include_drafts_failed_reserved_tags_and_legacy_channel(self):
        releases = [{'tag_name': 'desktop-v0.2.44', 'draft': False}, {'tag_name': 'desktop-v0.2.45', 'draft': True},
                    {'tag_name': 'friends-v0.2.46', 'draft': False}, {'tag_name': 'desktop-preview', 'draft': False}]
        refs = [{'ref': 'refs/tags/desktop-v0.2.47'}]
        self.assertEqual(c.next_version(releases, refs), '0.2.48')
        self.assertEqual(c.next_version([], []), '0.0.1')
        self.assertEqual(c.next_version([{'tag_name': 'desktop-v1.0.0'}], refs), '1.0.1')

    def test_intent_upload_precedes_tag_post_and_task_is_preparation_only(self):
        client, state, saved = FakeGitHub(), journal(), []
        client.published = [{'tag_name': 'desktop-v0.2.44', 'draft': False}]
        def create(tag, sha):
            self.assertEqual(saved[-1]['allocation']['outcome'], 'unknown')
            self.assertEqual(saved[-1]['allocation']['tag'], tag)
            client.tags[tag] = {'ref': 'refs/tags/' + tag, 'object': {'type': 'commit', 'sha': sha}}
            return 'accepted'
        with patch.object(client, 'create_tag', side_effect=create) as post:
            task = c.reserve(client, state, lambda value: saved.append(copy.deepcopy(value)))
            self.assertEqual(task['version'], '0.2.45')
            self.assertTrue(task['pipeline'] and task['tagged_candidate'] and task['preparation_only'])
            self.assertIs(c.reserve(client, state, lambda _: None), task)
            self.assertEqual(post.call_count, 1)

    def test_checkpoint_failure_prevents_mutation(self):
        client = FakeGitHub()
        def fail(_): raise ValueError('checkpoint offline')
        with self.assertRaises(ValueError): c.reserve(client, journal(), fail)
        self.assertEqual(client.creates, [])

    def test_lost_post_response_without_ref_never_resends_or_allocates_new_version(self):
        client, state = FakeGitHub(), journal(); client.tag_outcome = 'unknown'
        for _ in range(3):
            with self.assertRaisesRegex(ValueError, 'SAME coordinator'): c.reserve(client, state, lambda _: None)
        self.assertEqual(client.creates, [('desktop-v0.0.1', SHA)])
        client.tags['desktop-v0.0.1'] = {'ref': 'refs/tags/desktop-v0.0.1', 'object': {'type': 'commit', 'sha': SHA}}
        self.assertEqual(c.reserve(client, state, lambda _: None)['version'], '0.0.1')
        self.assertEqual(len(client.creates), 1)

    def test_known_conflict_may_advance_but_unknown_wrong_ref_cannot(self):
        client, state = FakeGitHub(), journal()
        def create(tag, sha):
            if tag == 'desktop-v0.0.1':
                client.tags[tag] = {'ref': 'refs/tags/' + tag, 'object': {'type': 'commit', 'sha': OTHER}}
                return 'conflict'
            client.tags[tag] = {'ref': 'refs/tags/' + tag, 'object': {'type': 'commit', 'sha': sha}}
            return 'accepted'
        with patch.object(client, 'create_tag', side_effect=create) as post:
            self.assertEqual(c.reserve(client, state, lambda _: None)['version'], '0.0.2')
            self.assertEqual(post.call_count, 2)
        state = journal(); state['allocation'] = {'version': '0.0.1', 'tag': 'desktop-v0.0.1', 'outcome': 'unknown'}
        with self.assertRaisesRegex(ValueError, 'SAME coordinator'): c.reserve(client, state, lambda _: None)

    def test_changed_restored_identity_pin_or_publication_intent_rejected(self):
        client, state = FakeGitHub(), journal()
        c.reserve(client, state, lambda _: None)
        c.validate_journal(state, client, old.ci(), SHA, 'all-macos-preview', None)
        for key, value in [('source_sha', OTHER), ('repository', 'other/repo'), ('publisher_pin', 'c'*40),
                           ('ci', {**old.ci(), 'run_attempt': 2})]:
            wrong = copy.deepcopy(state); wrong[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                c.validate_journal(wrong, client, old.ci(), SHA, 'all-macos-preview', None)
        for edit in (lambda t: t.update(preparation_only=False), lambda t: t['stages'].update(publish={}),
                     lambda t: t.update(version='0.0.2')):
            wrong = copy.deepcopy(state); edit(wrong['task'])
            with self.assertRaises(ValueError): c.validate_journal(wrong, client, old.ci(), SHA, 'all-macos-preview', None)


class Preparation(unittest.TestCase):
    def test_ci_change_between_allocation_and_dispatch_is_not_rebound(self):
        client, state = FakeGitHub(), journal()
        task_state = c.reserve(client, state, lambda _: None)
        client.cis.append({**old.ci(), 'run_attempt': 2})
        with self.assertRaisesRegex(ValueError, 'CI changed'):
            c.release.ReleaseTask(client, task_state, lambda _: None).advance()
        self.assertEqual(client.posts, [])

    def test_controller_reaches_ready_on_exact_old_source_without_any_promote(self):
        client = FakeGitHub(); client.sha = OTHER
        with tempfile.TemporaryDirectory() as folder:
            env = dict(GITHUB_ACTIONS='true', RUNNER_ENVIRONMENT='github-hosted', GITHUB_REF='refs/heads/master',
                       GITHUB_EVENT_NAME='workflow_run', GITHUB_REPOSITORY=REPO, GITHUB_SHA=OTHER,
                       GITHUB_WORKFLOW_REF=REPO + '/.github/workflows/desktop-candidates.yml@refs/heads/master',
                       TRIGGER_SOURCE_SHA=SHA, TRIGGER_CI_RUN_ID='1', TRIGGER_CI_ATTEMPT='1', RELEASE_SCOPE='all-macos-preview',
                       XHARNESS_FRIENDS_RELEASE_REPOSITORY=REPO, RUNNER_TEMP=folder, GITHUB_RUN_ID='77', GITHUB_RUN_ATTEMPT='2',
                       GITHUB_STEP_SUMMARY=str(Path(folder) / 'summary'))
            def advance(task, publish):
                self.assertFalse(publish)
                self.assertEqual(task.advance(), 'build_running')
                intent = task.state['stages']['build']; client.runs[intent['run_id']].update(status='completed', conclusion='success')
                return task.advance()
            with patch.dict(os.environ, env, clear=True), patch.object(c, 'CandidateGitHub', return_value=client), \
                    patch.object(c.service, 'restore_checkpoint', return_value=journal()) as restore, \
                    patch.object(c.service, 'advance_until_done', side_effect=advance), \
                    patch.object(c.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as node:
                self.assertEqual(c.main(), 0)
            ready = json.loads((Path(folder) / 'desktop-candidate-prepare/ready.json').read_text())
            self.assertEqual(ready['source_sha'], SHA); self.assertFalse(ready['published'])
            self.assertEqual(restore.call_args.args[-1], OTHER)
            self.assertGreater(node.call_count, 3, 'allocation and dispatch intents were uploaded before mutations')
            self.assertEqual([w for w, _ in client.posts], ['desktop-release.yml'])

    def test_master_movement_keeps_tagged_source_and_native_pipeline_then_stops(self):
        client, state = FakeGitHub(), journal()
        task_state = c.reserve(client, state, lambda _: None); client.sha = OTHER
        task = c.release.ReleaseTask(client, task_state, lambda _: None)
        self.assertEqual(task.advance(), 'build_running')
        self.assertEqual(client.posts[-1][1]['expected_sha'], SHA)
        self.assertFalse(client.posts[-1][1]['prepare_tag'])
        self.assertTrue(client.posts[-1][1]['automatic_candidate'])
        run = client.runs[task_state['stages']['build']['run_id']]
        self.assertEqual(run['head_branch'], 'desktop-v0.0.1')
        run.update(status='completed', conclusion='success')
        for _ in range(3): self.assertEqual(task.advance(), 'awaiting_confirmation')
        self.assertEqual(len(client.posts), 1)
        with self.assertRaisesRegex(ValueError, 'cannot authorize'): task.advance(confirm='0.0.1')
        self.assertEqual(len(client.posts), 1)

    def test_failed_build_or_source_ref_mismatch_never_becomes_ready(self):
        for edits in ({'conclusion': 'failure'}, {'head_branch': 'master'}, {'head_sha': OTHER}):
            client, state = FakeGitHub(), journal()
            task_state = c.reserve(client, state, lambda _: None)
            task = c.release.ReleaseTask(client, task_state, lambda _: None)
            task.advance(); run = client.runs[task_state['stages']['build']['run_id']]
            run.update({'status': 'completed', 'conclusion': 'success', **edits})
            with self.subTest(edits=edits), self.assertRaises(ValueError): task.advance()
            self.assertNotIn('publish', task_state['stages'])

    def test_bad_host_context_fails_before_any_network_or_artifact(self):
        with tempfile.TemporaryDirectory() as folder:
            env = dict(GITHUB_REPOSITORY=REPO, TRIGGER_SOURCE_SHA=SHA, RELEASE_SCOPE='all-macos-preview', RUNNER_TEMP=folder)
            with patch.dict(os.environ, env, clear=True), patch.object(c, 'CandidateGitHub') as client, patch('sys.stderr'):
                self.assertEqual(c.main(), 2)
            client.assert_not_called()
            self.assertEqual(list(Path(folder).iterdir()), [])


def reusable_plan():
    plan = c.release.contract.make_plan(REPO, REPO, 'desktop-v0.2.20', SHA, '42', '2', [], [old.ci()], 'all-macos-preview')
    plan['acceptance_mode'] = 'in-build'
    return plan


class Reuse(unittest.TestCase):
    def setup_candidate(self):
        client = FakeGitHub()
        run = {'id': 42, 'run_attempt': 2, 'head_sha': SHA, 'head_branch': 'desktop-v0.2.20',
               'event': 'workflow_dispatch', 'status': 'completed', 'conclusion': 'success',
               'path': '.github/workflows/desktop-release.yml', 'head_repository': {'full_name': REPO},
               'display_title': 'release-task ' + 'c'*32, 'created_at': '2026-10-13T00:00:00Z'}
        client.runs[42] = copy.deepcopy(run)
        client.job_rows[42] = [{'name': 'Signed ' + p + ' candidate', 'status': 'completed', 'conclusion': 'success'}
                               for p in c.build.PLATFORMS]
        return client, run

    def adopt(self, client, run, plan=None, **kwargs):
        value = reusable_plan() if plan is None else plan
        def download(repo, value, name, dest):
            dest.mkdir(); (dest / 'plan.json').write_text(json.dumps(value_plan))
        value_plan = value
        with patch.object(c.build, 'successful_run', return_value=run), patch.object(c.build, 'download_artifact', side_effect=download):
            return c.reuse_task(client, '42', kwargs.get('version', '0.2.20'), kwargs.get('scope'))

    def test_reuse_confirm_dispatches_only_promote_and_never_builds(self):
        client, run = self.setup_candidate()
        state = self.adopt(client, run)
        task = c.release.ReleaseTask(client, state, lambda _: None)
        self.assertEqual(task.advance(), 'awaiting_confirmation'); self.assertEqual(client.posts, [])
        self.assertEqual(task.advance(confirm='0.2.20'), 'publish_running')
        self.assertEqual([w for w, _ in client.posts], ['desktop-promote.yml'])
        self.assertEqual(client.posts[0][1]['release_run_id'], '42')
        self.assertEqual(client.posts[0][1]['unix_acceptance_run_id'], '42')
        self.assertEqual(client.posts[0][1]['windows_acceptance_run_id'], '42')
        with self.assertRaises(ValueError): task.advance(retry=True)
        self.assertEqual(len(client.posts), 1)

    def test_changed_version_scope_source_attempt_or_non_integrated_plan_rejected(self):
        for changes in ({'sha': OTHER}, {'release_run_attempt': '1'}, {'version': '0.2.21', 'tag': 'desktop-v0.2.21'},
                        {'release_scope': 'windows-linux'}, {'acceptance_mode': 'external'}):
            client, run = self.setup_candidate()
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.adopt(client, run, {**reusable_plan(), **changes})
            self.assertEqual(client.posts, [])
        client, run = self.setup_candidate()
        for scope in ('all', 'windows-linux'):
            with self.assertRaises(ValueError): self.adopt(client, run, scope=scope)

    def test_missing_platform_or_fresh_ci_change_is_not_reusable(self):
        client, run = self.setup_candidate(); client.job_rows[42].pop()
        with self.assertRaises(ValueError): self.adopt(client, run)
        client, run = self.setup_candidate(); client.cis.append({**old.ci(), 'run_attempt': 2})
        with self.assertRaisesRegex(ValueError, 'CI reran'): self.adopt(client, run)

    def test_build_latest_attempt_cannot_change_after_adoption(self):
        client, run = self.setup_candidate(); state = self.adopt(client, run)
        client.runs[42]['run_attempt'] = 3
        with self.assertRaisesRegex(ValueError, 'rerun'): c.release.ReleaseTask(client, state, lambda _: None).advance(confirm='0.2.20')
        self.assertEqual(client.posts, [])


class Provenance(unittest.TestCase):
    def test_candidate_cannot_regress_source_or_reuse_changed_stable_windows_base(self):
        live = {'tag_name': 'desktop-v0.2.19', 'target_commitish': OTHER}
        with patch.object(c.build._contract, 'remote_tag_commit', return_value=OTHER), \
                patch.object(c.build, 'ancestor') as ancestry:
            c.build.check_reuse_live_base(REPO, SHA, live, {'version': '0.2.19'}, {'base_version': '0.2.19'})
            ancestry.assert_called_once_with(REPO, OTHER, SHA)
            with self.assertRaisesRegex(ValueError, 'base changed'):
                c.build.check_reuse_live_base(REPO, SHA, live, {'version': '0.2.20'}, {'base_version': '0.2.19'})
        with patch.object(c.build._contract, 'remote_tag_commit', return_value=OTHER), \
                patch.object(c.build, 'ancestor', side_effect=ValueError('older source')), self.assertRaises(ValueError):
            c.build.check_reuse_live_base(REPO, SHA, live, {'version': '0.2.19'}, {'base_version': '0.2.19'})

    def test_tag_dispatch_requires_exact_ref_and_master_ancestor_not_general_branch(self):
        value = {**old.ci(), 'path': '.github/workflows/desktop-release.yml', 'event': 'workflow_dispatch',
                 'head_branch': 'desktop-v0.2.20', 'head_repository': {'full_name': REPO}}
        with patch.object(c.build, 'verify_tag') as tag, patch.object(c.build, 'ancestor') as ancestor, \
                patch.object(c.build, 'api', return_value={'object': {'sha': OTHER}}):
            c.build.check_run(value, REPO, SHA, value['path'])
            tag.assert_called_once_with(REPO, 'desktop-v0.2.20', SHA)
            ancestor.assert_called_once_with(REPO, SHA, OTHER)
        for branch in ('topic', 'desktop-v0.2.20-beta', 'desktop-v0.2.20\n', '../master'):
            with self.assertRaises(ValueError): c.build.check_run({**value, 'head_branch': branch}, REPO, SHA, value['path'])
        with self.assertRaises(ValueError):
            c.build.check_run(value, REPO, SHA, value['path'], event='workflow_dispatch')

    def test_checkpoint_identity_is_run_bound_and_uses_controller_not_candidate_sha(self):
        name = c.candidate_prefix('77') + '1-000001'
        row = {'name': name, 'workflow_run': {'head_sha': OTHER}, 'expired': False}
        self.assertEqual(c.service.select_checkpoint([row], c.candidate_prefix('77'), OTHER), row)
        with self.assertRaises(ValueError): c.service.select_checkpoint([row], c.candidate_prefix('77'), SHA)
        with tempfile.TemporaryDirectory() as folder:
            calls = []; persist = c.CandidateCheckpoints(Path(folder), '77', '1', lambda name, path: calls.append(name))
            persist(journal()); persist(journal())
            self.assertEqual(calls, [name])

    def test_workflows_cannot_publish_or_use_pr_artifacts_and_release_locks_are_separate(self):
        text = (ROOT / '.github/workflows/desktop-candidates.yml').read_text()
        for needle in ('workflow_run:', 'workflows: [CI]', 'types: [completed]', 'branches: [master]',
                       "conclusion == 'success'", "event == 'push'", 'head_repository.full_name == github.repository',
                       'cancel-in-progress: false', "candidate: 'true'"):
            self.assertIn(needle, text)
        for needle in ('PRIVATE_KEY', 'confirm-publish:', 'publish-after-acceptance', 'pull_request_target', 'desktop-promote.yml'):
            self.assertNotIn(needle, text)
        release_text = (ROOT / '.github/workflows/desktop-release.yml').read_text()
        self.assertIn("inputs.automatic_candidate && format('desktop-candidate-build-{0}', inputs.release_tag)", release_text)
        self.assertIn("|| 'desktop-stable-release'", release_text)
        self.assertIn('AUTOMATIC_CANDIDATE: ${{ inputs.automatic_candidate }}', release_text)
        self.assertNotIn('publish --workspace', release_text)
        self.assertIn('Stage one complete draft, never latest', release_text)
        self.assertIn('scripts/test-desktop-candidates.py', (ROOT / '.github/workflows/ci.yml').read_text())


if __name__ == '__main__':
    unittest.main()
