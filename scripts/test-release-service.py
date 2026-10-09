#!/usr/bin/env python3
"""Offline hosted/pipelined release regression. No signing secrets or Rust."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result
service = module('service', 'desktop-release-service.py')
release = service.release
build = module('build_service', 'desktop-release-build.py')
old = module('old_tests', 'test-release-orchestrator.py')
SHA, REPO = old.SHA, old.REPO


def plan(pipeline=True):
    value = build._contract.make_plan(REPO, REPO, 'desktop-v0.2.20', SHA, '123', '2', [], [old.ci()], 'all-macos-preview')
    if pipeline: value['acceptance_mode'] = 'in-build'
    return value


class Pipeline(unittest.TestCase):
    def test_build_failure_cannot_skip_native_tests_or_publish(self):
        client = old.FakeGitHub()
        state = release.new_task(REPO, '0.2.20', 'all-macos-preview', SHA, pipeline=True)
        task = release.ReleaseTask(client, state, lambda _: None)
        task.advance()
        self.assertTrue(client.posts[0][1]['integrated_acceptance'])
        client.runs[10].update(status='completed', conclusion='failure')
        with self.assertRaises(release.TaskError): task.advance()
        self.assertEqual(len(client.posts), 1)

    def test_one_build_contains_all_native_gates_then_one_promotion(self):
        client = old.FakeGitHub()
        state = release.new_task(REPO, '0.2.20', 'all-macos-preview', SHA, pipeline=True)
        task = release.ReleaseTask(client, state, lambda _: None)
        task.advance()
        client.runs[10].update(status='completed', conclusion='success')
        self.assertEqual(task.advance(), 'awaiting_confirmation')
        self.assertEqual(len(client.posts), 1)
        task.advance(confirm='0.2.20')
        self.assertEqual(client.posts[1][0], 'desktop-promote.yml')
        self.assertEqual(client.posts[1][1]['release_run_id'], '10')
        self.assertEqual(client.posts[1][1]['unix_acceptance_run_id'], '10')
        self.assertEqual(client.posts[1][1]['windows_acceptance_run_id'], '10')
        client.runs[11].update(status='completed', conclusion='success')
        self.assertEqual(task.advance(), 'published')

    def test_legacy_task_cannot_be_silently_changed_to_pipeline(self):
        client = old.FakeGitHub()
        state = release.new_task(REPO, '0.2.20', 'all-macos-preview', SHA)
        task = release.ReleaseTask(client, state, lambda _: None)
        task.advance(); state['pipeline'] = True
        with self.assertRaisesRegex(release.TaskError, 'inputs changed'): task.advance()
        self.assertEqual(len(client.posts), 1)

    def test_unknown_modes_are_rejected_and_receipts_bind_mode(self):
        build._contract.validate_plan(plan())
        self.assertEqual(build._contract.acceptance_workflow(plan(), 'darwin-aarch64'), '.github/workflows/desktop-release.yml')
        self.assertEqual(build._contract.acceptance_workflow(plan(False), 'darwin-aarch64'), '.github/workflows/desktop-unix-update-acceptance.yml')
        for bad in ['', None, False, 'rehearsal', 'skip']:
            value = plan(); value['acceptance_mode'] = bad
            with self.subTest(bad=bad), self.assertRaises(ValueError): build._contract.validate_plan(value)

    def test_current_build_handoff_rejects_foreign_run_attempt_source_and_trigger(self):
        p = plan()
        env = dict(GITHUB_ACTIONS='true', RUNNER_ENVIRONMENT='github-hosted', GITHUB_REPOSITORY=REPO,
                   XHARNESS_FRIENDS_RELEASE_REPOSITORY=REPO, GITHUB_SHA=SHA, GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='2')
        good = dict(id=123, path='.github/workflows/desktop-release.yml', head_repository={'full_name': REPO},
                    head_sha=SHA, run_attempt=2, status='in_progress', conclusion=None, event='workflow_dispatch', head_branch='master')
        with patch.dict(os.environ, env), patch.object(build, 'api', return_value=good):
            self.assertEqual(build.current_build(p), good)
        for change in [{'head_sha': 'b'*40}, {'run_attempt': 1}, {'status': 'completed'}, {'conclusion': 'failure'},
                       {'event': 'pull_request'}, {'head_branch': 'dev'}, {'path': '.github/workflows/evil.yml'},
                       {'head_repository': {'full_name': 'someone/fork'}}]:
            with self.subTest(change=change), patch.dict(os.environ, env), patch.object(build, 'api', return_value={**good, **change}), self.assertRaises(ValueError):
                build.current_build(p)
        with patch.dict(os.environ, env), self.assertRaises(ValueError): build.current_build(plan(False))

    def test_missing_failed_or_ambiguous_artifacts_never_form_a_candidate(self):
        value = dict(id=123, run_attempt=2, run_started_at='2026-10-06T00:00:00Z')
        a = dict(name='desktop-candidate', expired=False, created_at='2026-10-06T01:00:00Z', workflow_run={'head_sha': SHA})
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for rows, jobs in [([a, a], []), ([{**a, 'expired': True}], []), ([{**a, 'workflow_run': {'head_sha':'b'*40}}], []),
                               ([], [{'status':'completed','conclusion':'failure'}])]:
                def response(*args, **kwargs):
                    return json.dumps([{'artifacts': rows}]) if '/artifacts?' in ' '.join(map(str,args)) else json.dumps([{'jobs': jobs}])
                with self.subTest(rows=rows), patch.object(build, 'current_build', return_value=value), patch.object(build, 'run', side_effect=response), self.assertRaises(ValueError):
                    build.wait_build_artifacts(plan(), ['desktop-candidate'], root / 'output', timeout=1, interval=1)
                self.assertFalse((root / 'output').exists())

    def test_get_retries_are_bounded_but_dispatch_is_never_wrapped(self):
        import subprocess
        error = subprocess.CalledProcessError(1, ['gh', 'api'])
        with patch.object(build, 'run', side_effect=[error, error, '{"ok":true}']) as calls, patch.object(build.time, 'sleep'):
            self.assertEqual(build.api('repos/owner/project/actions/runs/1'), {'ok':True})
            self.assertEqual(calls.call_count, 3)
        with patch.object(build, 'run', side_effect=error) as calls, patch.object(build.time, 'sleep'), self.assertRaises(ValueError):
            build.api('repos/owner/project/actions/runs/1')
        self.assertEqual(calls.call_count, 3)
        with patch.object(release, 'gh', side_effect=release.TransportError('offline')) as calls:
            with self.assertRaises(release.TransportError):
                release.GitHub(REPO).dispatch('desktop-release.yml', {})
            self.assertEqual(calls.call_count, 1)

    def test_artifact_wait_is_bounded_and_cannot_merge_an_existing_candidate(self):
        value = dict(id=123, run_attempt=2, run_started_at='2026-10-06T00:00:00Z')
        with tempfile.TemporaryDirectory() as folder, patch.object(build, 'current_build', return_value=value), \
                patch.object(build, 'run', side_effect=[json.dumps([{'artifacts':[]}]), json.dumps([{'jobs':[]}])]), \
                patch.object(build.time, 'monotonic', side_effect=[0, 2]), self.assertRaisesRegex(ValueError, 'Timed out'):
            build.wait_build_artifacts(plan(), ['desktop-candidate'], Path(folder)/'output', timeout=1)
        with tempfile.TemporaryDirectory() as folder, self.assertRaisesRegex(ValueError, 'fresh'):
            build.wait_build_artifacts(plan(), ['desktop-candidate'], Path(folder))


class CheckpointTests(unittest.TestCase):
    def test_revision_order_not_api_order_and_reject_ambiguous_expired_or_wrong_source(self):
        def row(n, attempt=1):
            return {'name':service.artifact_prefix('0.2.20','77') + f'{attempt}-{n:06d}', 'expired':False, 'workflow_run':{'head_sha':SHA}}
        a,b,c = row(3),row(9),row(1,2)
        self.assertEqual(service.latest_checkpoint([c,b,a],'0.2.20','77',SHA),c)
        self.assertIsNone(service.latest_checkpoint([{'name':'unrelated'}],'0.2.20','77',SHA))
        for rows in [[a,a],[{**a,'expired':True}],[{**a,'workflow_run':{'head_sha':'b'*40}}],[{**a,'name':a['name']+'bad'}]]:
            with self.assertRaises(release.TaskError): service.latest_checkpoint(rows,'0.2.20','77',SHA)

    def test_upload_is_write_ahead_and_deduplicated(self):
        saved=[]
        with tempfile.TemporaryDirectory() as folder:
            cp=service.Checkpoints(Path(folder),'0.2.20','77','1',lambda name,path:saved.append(json.loads(path.read_text())))
            client=old.FakeGitHub()
            state=release.new_task(REPO,'0.2.20','all-macos-preview',SHA,pipeline=True)
            # FakeGitHub raises its own module's transport class only in the
            # handoff-specific tests below; here the dispatch itself succeeds.
            client.on_dispatch=lambda *_:self.assertEqual(saved[-1]['stages']['build']['dispatch'],'unknown')
            task=release.ReleaseTask(client,state,cp); task.advance()
            count=len(saved); task.advance(); task.advance()
            self.assertLessEqual(len(saved),count+1)

    def test_checkpoint_upload_failure_prevents_dispatch(self):
        with tempfile.TemporaryDirectory() as folder:
            def fail(*_): raise release.TaskError('upload failed')
            cp=service.Checkpoints(Path(folder),'0.2.20','77','1',fail)
            client=old.FakeGitHub()
            task=release.ReleaseTask(client,release.new_task(REPO,'0.2.20','all-macos-preview',SHA,pipeline=True),cp)
            with self.assertRaises(release.TaskError): task.advance()
            self.assertEqual(client.posts,[])

    def test_failed_build_is_not_transport_retried(self):
        class Task:
            state={'version':'0.2.20','phase':'build_failed'}
            def advance(self,**kwargs): raise release.TaskError('native failed')
        with self.assertRaises(release.TaskError): service.advance_until_done(Task(),True,sleep=lambda _:self.fail('must not retry'))

    def test_transport_recovery_is_bounded(self):
        class Task:
            state={'version':'0.2.20','phase':'build_running'}
            calls=0
            def advance(self,**kwargs): self.calls+=1; raise release.TransportError('read failed')
        task=Task(); delays=[]
        with self.assertRaisesRegex(release.TaskError,'bounded'):
            service.advance_until_done(task,True,sleep=delays.append,clock=lambda:0)
        self.assertEqual(task.calls,7); self.assertEqual(delays,[5,10,20,40,60,60])

    def test_hosted_handoff_lost_response_does_not_post_twice(self):
        client=old.FakeGitHub()
        original=client.dispatch
        def lost(workflow,inputs): original(workflow,inputs); raise release.TransportError('reply lost')
        client.dispatch=lost
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'task.json'
            service.handoff(client,path,'0.2.20','all-macos-preview',True)
            result=service.handoff(client,path,'0.2.20','all-macos-preview',True)
            self.assertEqual(result['status'],'queued'); self.assertEqual(len(client.posts),1)
            with self.assertRaises(release.TaskError): service.handoff(client,path,'0.2.20','windows-linux',True)
            with self.assertRaises(release.TaskError): service.handoff(client,path,'0.2.20','all-macos-preview',False)

    def test_rerun_without_a_checkpoint_cannot_blindly_start(self):
        class Client:
            repo=REPO
            def pages(self,*_):return []
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'GITHUB_RUN_ATTEMPT':'2'}), self.assertRaises(release.TaskError):
            service.restore(Client(),Path(folder),'0.2.20','77',SHA)


class GraphTests(unittest.TestCase):
    def test_no_worker_aggregate_cycle_and_candidate_upload_precedes_native_work(self):
        text=(ROOT/'.github/workflows/desktop-release.yml').read_text()
        build=text.split('  build:',1)[1].split('  aggregate:',1)[0]
        aggregate=text.split('  aggregate:',1)[1]
        self.assertIn('needs: plan',aggregate); self.assertNotIn('needs: [plan, build]',aggregate)
        self.assertLess(build.index('path: dist/desktop-package/'),build.index('prepare-in-build'))
        self.assertLess(aggregate.index('wait-packages'),aggregate.index('stage-draft'))
        self.assertIn('fetch-in-build',build); self.assertIn('native-run',build)
        self.assertIn('windows-migration-acceptance.ps1',build)
        self.assertEqual(build.count('cargo build --locked --release -p xharness-host-app'),1)
        self.assertIn('cache-on-failure: true',build)
        self.assertNotIn('contents: write',build)

    def test_coordinator_never_holds_child_publication_lock_or_has_signing_secrets(self):
        text=(ROOT/'.github/workflows/desktop-release-service.yml').read_text()
        self.assertIn('group: desktop-release-service',text)
        self.assertNotIn('group: desktop-stable-release',text)
        self.assertNotIn('PRIVATE_KEY',text); self.assertIn('persist-credentials: false',text)
        self.assertIn('default: false',text)


if __name__=='__main__':unittest.main()
