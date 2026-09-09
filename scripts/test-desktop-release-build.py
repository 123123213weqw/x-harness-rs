#!/usr/bin/env python3
"""No-secret, no-network orchestration regression tests. Never compiles Rust."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('desktop_build', ROOT / 'scripts/desktop-release-build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
SHA = 'a' * 40
NEW_SHA = 'b' * 40
REPO = 'owner/project'


def successful(path='.github/workflows/desktop-release.yml', event='push'):
    return {'id': 42, 'head_sha': SHA, 'path': path, 'head_repository': {'full_name': REPO},
            'event': event, 'head_branch': 'desktop-v0.2.6' if event == 'push' else 'master',
            'status': 'completed', 'conclusion': 'success', 'run_attempt': 2,
            'run_started_at': '2026-09-08T01:00:00Z', 'updated_at': '2026-09-08T02:00:00Z'}


def release():
    return {'id': 12, 'tag_name': 'desktop-v0.2.6', 'target_commitish': SHA,
            'name': 'XHarness', 'body': 'Reviewed', 'draft': True, 'prerelease': False,
            'created_at': '2026-09-08', 'published_at': None,
            'assets': [{'id': 4, 'name': 'latest.json', 'size': 10, 'state': 'uploaded',
                        'digest': 'sha256:' + SHA, 'created_at': '2026-09-08', 'updated_at': '2026-09-08'}]}


class SigningGate(unittest.TestCase):
    def environment(self):
        return dict(TAURI_SIGNING_PRIVATE_KEY='dummy-do-not-use', TAURI_SIGNING_PRIVATE_KEY_PASSWORD='dummy',
                    XHARNESS_UPDATER_PUBKEY='dummy', APPLE_CERTIFICATE='dummy', APPLE_CERTIFICATE_PASSWORD='dummy',
                    APPLE_SIGNING_IDENTITY='Developer ID Application: Example (ABCDEFGHIJ)',
                    APPLE_TEAM_ID='ABCDEFGHIJ', APPLE_ID='dummy', APPLE_PASSWORD='dummy')

    def test_real_apple_configuration_is_required(self):
        env = self.environment()
        build.signing_gate('darwin-aarch64', env)
        for name in env:
            broken = {**env, name: ''}
            with self.subTest(name=name), self.assertRaises(ValueError):
                build.signing_gate('darwin-aarch64', broken)

    def test_no_adhoc_or_development_downgrade(self):
        for identity in ['-', 'Apple Development: Example', 'Developer ID Application', '']:
            with self.subTest(identity=identity), self.assertRaises(ValueError):
                build.signing_gate('darwin-x86_64', {**self.environment(), 'APPLE_SIGNING_IDENTITY': identity})
        with self.assertRaises(ValueError):
            build.signing_gate('darwin-aarch64', {**self.environment(), 'APPLE_TEAM_ID': 'wrong'})

    def test_windows_and_linux_do_not_require_apple_credentials(self):
        env = {k: v for k, v in self.environment().items() if not k.startswith('APPLE_')}
        build.signing_gate('windows-x86_64', env)
        build.signing_gate('linux-x86_64-appimage', env)


class ScopeMatrix(unittest.TestCase):
    def test_selected_build_and_unix_acceptance_matrices(self):
        plan = {'release_scope': 'windows-linux'}
        self.assertEqual([p['platform'] for p in build.platform_matrix(plan)['include']],
                         ['windows-x86_64', 'linux-x86_64-appimage'])
        self.assertEqual(build.platform_matrix(plan, unix_only=True), {'include': [{
            'platform': 'linux-x86_64-appimage', 'runner': 'ubuntu-22.04',
            'target': 'x86_64-unknown-linux-gnu', 'bundles': 'appimage'}]})
        self.assertEqual(len(build.platform_matrix({}, unix_only=True)['include']), 3)
        with self.assertRaises(ValueError):
            build.platform_matrix({'release_scope': 'linux'})

    def test_selected_signing_plan_keeps_apple_gate_for_full_scope(self):
        contract = build._contract
        sha = 'a' * 40
        ci = dict(id=1, run_attempt=1, head_sha=sha, head_branch='master', event='push',
                  status='completed', conclusion='success', path='.github/workflows/ci.yml')
        args = dict(repository='owner/project', configured_repository='owner/project',
                    tag='desktop-v0.2.10', sha=sha, run_id='1', attempt='1', releases=[], runs=[ci])
        env = {k: v for k, v in SigningGate().environment().items() if not k.startswith('APPLE_')}
        build.signing_plan(contract.make_plan(**args, release_scope='windows-linux'), env)
        with self.assertRaises(ValueError):
            build.signing_plan(contract.make_plan(**args), env)
        for key in env:
            with self.subTest(key=key), self.assertRaises(ValueError):
                build.signing_plan(contract.make_plan(**args, release_scope='windows-linux'), {**env, key: ''})

    def test_candidate_matrix_cannot_be_selected_by_untrusted_dispatch_input(self):
        text = (ROOT / '.github/workflows/desktop-unix-update-acceptance.yml').read_text(encoding='utf-8')
        self.assertIn('fromJSON(needs.select.outputs.matrix)', text)
        self.assertIn('fetch-candidate --release-run-id', text)
        self.assertIn('acceptance-matrix --candidate', text)
        self.assertNotIn('inputs.release_scope', text)


class Provenance(unittest.TestCase):
    def test_release_push_and_dispatch_supported(self):
        for event in ['push', 'workflow_dispatch']:
            build.check_run(successful(event=event), REPO, SHA, '.github/workflows/desktop-release.yml')

    def test_forged_or_incomplete_build_provenance_rejected(self):
        for field, value in [('head_sha', NEW_SHA), ('path', '.github/workflows/ci.yml'),
                             ('status', 'in_progress'), ('conclusion', 'failure'), ('event', 'pull_request'),
                             ('run_attempt', 0), ('head_repository', {'full_name': 'other/project'})]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                build.check_run({**successful(), field: value}, REPO, SHA, '.github/workflows/desktop-release.yml')

    def test_native_workflow_controls_can_advance_but_not_leave_master(self):
        path = build.ACCEPTANCE_WORKFLOWS['unix']
        value = {**successful(path, 'workflow_dispatch'), 'head_sha': NEW_SHA}
        build.check_run(value, REPO, None, path, event='workflow_dispatch')
        for field, item in [('head_branch', 'feature'), ('event', 'pull_request'), ('path', 'arbitrary.yml')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                build.check_run({**value, field: item}, REPO, None, path, event='workflow_dispatch')

    def test_skipped_jobs_and_stale_attempts_do_not_count(self):
        value = successful()
        for conclusion in ['skipped', 'failure', 'cancelled', None]:
            jobs = [{'jobs': [{'status': 'completed', 'conclusion': conclusion}]}]
            with self.subTest(conclusion=conclusion), patch.object(build, 'api', return_value=value), \
                    patch.object(build, 'run', return_value=json.dumps(jobs)), self.assertRaises(ValueError):
                build.successful_run(REPO, '42', SHA, value['path'])
        jobs = [{'jobs': [{'status': 'completed', 'conclusion': 'success'}]}]
        with patch.object(build, 'api', return_value=value), patch.object(build, 'run', return_value=json.dumps(jobs)):
            self.assertEqual(build.successful_run(REPO, '42', SHA, value['path'])['run_attempt'], 2)

    def test_source_must_be_on_trusted_ancestor_chain(self):
        with patch.object(build, 'api', return_value={'status': 'ahead'}):
            build.ancestor(REPO, SHA, NEW_SHA)
        for status in ['behind', 'diverged']:
            with patch.object(build, 'api', return_value={'status': status}), self.assertRaises(ValueError):
                build.ancestor(REPO, SHA, NEW_SHA)
        with self.assertRaises(ValueError):
            build.ancestor(REPO, '../master', NEW_SHA)

    def test_artifacts_from_old_attempt_or_duplicate_name_are_rejected(self):
        value = successful()
        good = {'id': 99, 'name': 'desktop-candidate', 'expired': False,
                'workflow_run': {'head_sha': SHA}, 'created_at': '2026-09-08T01:30:00Z'}
        invalid = [[{**good, 'created_at': '2026-09-08T00:00:00Z'}], [good, good],
                   [{**good, 'expired': True}], [{**good, 'workflow_run': {'head_sha': NEW_SHA}}], []]
        for artifacts in invalid:
            with self.subTest(artifacts=artifacts), tempfile.TemporaryDirectory() as directory, \
                    patch.object(build, 'run', return_value=json.dumps([{'artifacts': artifacts}])), self.assertRaises(ValueError):
                build.download_artifact(REPO, value, 'desktop-candidate', Path(directory) / 'new')


class DraftAndLive(unittest.TestCase):
    def test_snapshot_binds_metadata_and_asset_identity(self):
        original = build.snapshot(release())
        for field, value in [('body', 'changed'), ('draft', False), ('target_commitish', NEW_SHA)]:
            self.assertNotEqual(original, build.snapshot({**release(), field: value}))
        for field, value in [('id', 5), ('size', 11), ('digest', 'sha256:changed'), ('updated_at', 'changed')]:
            changed = release(); changed['assets'][0][field] = value
            self.assertNotEqual(original, build.snapshot(changed))
        changed = release(); changed['assets'].append(copy.deepcopy(changed['assets'][0]))
        with self.assertRaises(ValueError): build.snapshot(changed)
        changed = release(); changed['assets'][0]['state'] = 'new'
        with self.assertRaises(ValueError): build.snapshot(changed)

    def test_tag_is_peeled_and_rechecked_not_merely_present(self):
        with patch.object(build, 'api', return_value={'object': {'type': 'commit', 'sha': SHA}}):
            build.verify_tag(REPO, 'desktop-v0.2.6', SHA)
        objects = [{'object': {'type': 'tag', 'sha': NEW_SHA}}, {'object': {'type': 'commit', 'sha': SHA}}]
        with patch.object(build, 'api', side_effect=objects): build.verify_tag(REPO, 'desktop-v0.2.6', SHA)
        for kind in ['tree', 'blob', 'commit']:
            with patch.object(build, 'api', return_value={'object': {'type': kind, 'sha': NEW_SHA}}), self.assertRaises(ValueError):
                build.verify_tag(REPO, 'desktop-v0.2.6', SHA)
        with patch.object(build, 'api', return_value={'object': {'type': 'tag', 'sha': NEW_SHA}}), self.assertRaises(ValueError):
            build.verify_tag(REPO, 'desktop-v0.2.6', SHA)

    def test_live_assets_must_stay_in_immutable_repository_and_tag(self):
        prefix = f'https://github.com/{REPO}/releases/download/friends-v0.2.5/'
        manifest = {'platforms': {'windows-x86_64': {'url': prefix + 'XHarness_0.2.5_x64-setup.exe'}}}
        names = build.live_names(manifest, REPO, 'friends-v0.2.5')
        self.assertEqual(len(names), 4)
        for url in ['http://github.com/' + REPO, prefix + '../escape', prefix + '%2e%2e%2fescape',
                    prefix + 'file?token=private', prefix + 'file#fragment', prefix.replace('github.com', 'evil.invalid') + 'file',
                    prefix.replace('friends-v0.2.5', 'friends-v0.2.4') + 'file']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                build.live_names({'platforms': {'windows-x86_64': {'url': url}}}, REPO, 'friends-v0.2.5')

    def test_byte_drift_extra_files_and_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            a, b = Path(temporary) / 'a', Path(temporary) / 'b'
            a.mkdir(); b.mkdir()
            (a / 'asset').write_bytes(b'good'); (b / 'asset').write_bytes(b'good')
            build.compare_release_files(a, b)
            (b / 'asset').write_bytes(b'bad!')
            with self.assertRaises(ValueError): build.compare_release_files(a, b)
            (b / 'asset').unlink(); (b / 'asset').symlink_to(a / 'asset')
            with self.assertRaises(ValueError): build.compare_release_files(a, b)
            (b / 'asset').unlink(); (b / 'extra').write_text('extra')
            with self.assertRaises(ValueError): build.compare_release_files(a, b)


class DraftIdentity(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.plan = {'repository': REPO, 'sha': SHA, 'tag': 'desktop-v0.2.6',
                     'version': '0.2.6', 'release_scope': 'windows-linux'}
        build.write(self.root / 'plan.json', self.plan)
        (self.root / 'release').mkdir()
        (self.root / 'release/latest.json').write_bytes(b'1234567890')
        self.created = {**release(), 'assets': []}
        self.remote = release()
        self.pages = [[]]
        self.create_error = None
        self.upload_error = None
        self.args = type('Args', (), {'candidate': self.root})()
        for p in (patch.object(build, 'trusted_checkout', return_value=(REPO, SHA)),
                  patch.object(build, 'contract'), patch.object(build, 'verify_tag'),
                  patch.dict(os.environ, {'GITHUB_SHA': SHA})):
            p.start(); self.addCleanup(p.stop)
        p = patch.object(build, 'run', side_effect=self.command)
        self.command_mock = p.start(); self.addCleanup(p.stop)
        p = patch.object(build, 'api', side_effect=self.read)
        self.api_mock = p.start(); self.addCleanup(p.stop)

    def command(self, *args, **kwargs):
        if '--paginate' in args:
            return json.dumps(self.pages)
        if 'POST' in args:
            if self.create_error: raise self.create_error
            return json.dumps(self.created)
        if args[:3] == ('gh', 'release', 'upload'):
            if self.upload_error: raise self.upload_error
            return None
        raise AssertionError(f'Unexpected command: {args}')

    def read(self, path):
        if path == f'repos/{REPO}/releases/12':
            return self.remote
        raise AssertionError('Published-only tag endpoint is unavailable for this draft: ' + path)

    def test_stage_captures_create_id_when_published_tag_lookup_is_404(self):
        build.stage_draft(self.args)
        self.api_mock.assert_called_once_with(f'repos/{REPO}/releases/12')
        self.assertEqual(build.load(self.root / 'draft-snapshot.json'), build.snapshot(self.remote))
        self.assertEqual(build.load(self.root / 'draft-created.json')['id'], 12)
        create = [c for c in self.command_mock.call_args_list if 'POST' in c.args]
        self.assertEqual(len(create), 1)
        for value in ['draft=true', 'prerelease=false', 'make_latest=false', 'tag_name=desktop-v0.2.6', 'target_commitish=' + SHA]:
            self.assertIn(value, create[0].args)

    def test_existing_published_or_draft_on_later_page_is_not_reused(self):
        for draft in (True, False):
            self.pages = [[{**release(), 'tag_name': 'desktop-v0.2.5'}], [{**release(), 'draft': draft}]]
            with self.subTest(draft=draft), self.assertRaisesRegex(ValueError, 'already exists'):
                build.stage_draft(self.args)
        self.assertFalse(any('POST' in c.args for c in self.command_mock.call_args_list))

    def test_uncertain_creation_is_not_retried_and_preserves_intent(self):
        self.create_error = TimeoutError('private server body')
        with self.assertRaisesRegex(ValueError, 'uncertain') as error:
            build.stage_draft(self.args)
        self.assertNotIn('private server body', str(error.exception))
        self.assertEqual(len([c for c in self.command_mock.call_args_list if 'POST' in c.args]), 1)
        self.assertTrue((self.root / 'draft-creation-attempt.json').exists())
        self.assertFalse((self.root / 'draft-snapshot.json').exists())
        self.api_mock.assert_not_called()

    def test_upload_failure_keeps_created_id_and_cannot_emit_accepted_snapshot(self):
        self.upload_error = OSError('upload stopped')
        with self.assertRaises(OSError): build.stage_draft(self.args)
        self.assertEqual(build.load(self.root / 'draft-created.json')['id'], 12)
        self.assertFalse((self.root / 'draft-snapshot.json').exists())
        self.api_mock.assert_not_called()

    def test_bad_creation_identity_is_rejected_before_upload(self):
        self.created['target_commitish'] = NEW_SHA
        with self.assertRaises(ValueError): build.stage_draft(self.args)
        self.assertFalse(any(c.args[:3] == ('gh', 'release', 'upload') for c in self.command_mock.call_args_list))

    def test_metadata_and_asset_changes_during_upload_fail_closed(self):
        for field, value in [('body', 'changed'), ('name', 'replaced'), ('asset.size', 11), ('asset.name', 'unexpected')]:
            with self.subTest(field=field):
                self.remote = release()
                if field.startswith('asset.'):
                    self.remote['assets'][0][field.split('.')[1]] = value
                else:
                    self.remote[field] = value
                # Independent candidate workspace per attempt; no overwriting.
                with tempfile.TemporaryDirectory() as temporary:
                    candidate = Path(temporary)
                    build.write(candidate / 'plan.json', self.plan)
                    (candidate / 'release').mkdir()
                    (candidate / 'release/latest.json').write_bytes(b'1234567890')
                    with self.assertRaises(ValueError):
                        build.stage_draft(type('Args', (), {'candidate': candidate})())
                    self.assertFalse((candidate / 'draft-snapshot.json').exists())

    def test_bound_lookup_uses_id_and_checks_full_snapshot(self):
        expected = build.snapshot(release())
        self.assertEqual(build.bound_draft(REPO, self.plan, expected), self.remote)
        self.api_mock.assert_called_once_with(f'repos/{REPO}/releases/12')
        for field, value in [('id', 99), ('tag_name', 'desktop-v0.9.0'), ('target_commitish', NEW_SHA),
                             ('draft', False), ('prerelease', True), ('body', 'changed')]:
            self.remote = {**release(), field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                build.bound_draft(REPO, self.plan, expected)

    def test_missing_or_unsafe_id_is_rejected_without_network(self):
        for value in (None, True, 0, -1, '12', '../latest'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                build.bound_draft(REPO, self.plan, {**build.snapshot(release()), 'id': value})
        self.api_mock.assert_not_called()

    def test_bound_id_404_never_falls_back_to_same_tag(self):
        self.api_mock.side_effect = OSError('404')
        with self.assertRaises(OSError):
            build.bound_draft(REPO, self.plan, build.snapshot(release()))
        self.api_mock.assert_called_once_with(f'repos/{REPO}/releases/12')

    def test_publish_rechecks_same_bound_id_and_rejects_final_drift(self):
        for drift in (False, True):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                live = {**release(), 'id': 13, 'tag_name': 'friends-v0.2.5', 'draft': False}
                build.write(root / 'candidate/plan.json', self.plan)
                build.write(root / 'candidate/draft-snapshot.json', build.snapshot(release()))
                build.write(root / 'live-snapshot.json', build.snapshot(live))
                build.write(root / 'live/latest.json', {'platforms': {'windows-x86_64': {
                    'url': f'https://github.com/{REPO}/releases/download/friends-v0.2.5/setup.exe'}}})
                build.write(root / 'provenance.json', {'release': {'run': successful()}})
                draft_reads = []
                def read(path):
                    if path.endswith('/releases/latest'): return live
                    if path == f'repos/{REPO}/releases/12':
                        draft_reads.append(path)
                        if drift and len(draft_reads) == 2: return {**release(), 'body': 'raced'}
                        return release()
                    raise AssertionError('Unexpected API path: ' + path)
                with patch.object(build, 'api', side_effect=read), \
                        patch.object(build, 'successful_run', return_value=successful()), \
                        patch.object(build, 'download_release'), patch.object(build, 'compare_release_files'), \
                        patch.object(build, 'promote_draft') as promote:
                    args = type('Args', (), {'workspace': root})()
                    if drift:
                        with self.assertRaisesRegex(ValueError, 'Draft changed'): build.publish(args)
                        promote.assert_not_called()
                    else:
                        build.publish(args)
                        promote.assert_called_once_with(REPO, release(), root)
                self.assertEqual(len(draft_reads), 2)

    def test_all_draft_queries_and_failure_evidence_use_safe_paths(self):
        source = (ROOT / 'scripts/desktop-release-build.py').read_text(encoding='utf-8')
        self.assertNotIn('/releases/tags/', source)
        workflow = (ROOT / '.github/workflows/desktop-release.yml').read_text(encoding='utf-8')
        evidence = workflow.split('- name: Preserve public-material draft identity', 1)[1]
        self.assertIn('if: always()', evidence)
        for name in ('draft-creation-attempt.json', 'draft-created.json', 'draft-snapshot.json'):
            self.assertIn('dist/desktop-candidate/' + name, evidence)
        self.assertNotIn('private', evidence)
        self.assertNotIn('dist/desktop-candidate/\n', evidence)


class PublicPublication(unittest.TestCase):
    def test_rolling_feed_is_verified_without_auth_and_old_cdn_bytes_are_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'final-draft').mkdir()
            for name, data in [('latest.json', b'new-feed'), ('updater.pub', b'public-key')]:
                (root / 'final-draft' / name).write_bytes(data)
            with patch.object(build, 'public_bytes', side_effect=[b'old-feed', b'public-key', b'new-feed', b'public-key']) as read, \
                    patch.object(build.time, 'sleep') as sleep:
                receipt = build.verify_public_channel(REPO, root)
            self.assertEqual(receipt['attempts'], 2)
            self.assertFalse(receipt['authenticated'])
            self.assertEqual(read.call_args.args, (f'https://github.com/{REPO}/releases/latest/download/updater.pub',))
            sleep.assert_called_once_with(2)

    def test_failed_public_reads_are_bounded_and_never_expose_remote_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'final-draft').mkdir()
            for name in ['latest.json', 'updater.pub']:
                (root / 'final-draft' / name).write_bytes(b'expected')
            with patch.object(build, 'public_bytes', side_effect=OSError('remote-private-body')) as read, \
                    patch.object(build.time, 'sleep'), self.assertRaisesRegex(ValueError, 'four bounded reads') as error:
                build.verify_public_channel(REPO, root)
            self.assertNotIn('remote-private-body', str(error.exception))
            self.assertEqual(read.call_count, 4)

    def test_public_request_has_no_authorization_and_checks_size_and_https(self):
        class Response:
            status = 200
            def __init__(self, body, url): self.body, self.url = body, url
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def geturl(self): return self.url
            def read(self, maximum): return self.body[:maximum]
        with patch.object(build, 'urlopen', return_value=Response(b'ok', 'https://release-assets.githubusercontent.com/public')) as request:
            self.assertEqual(build.public_bytes('https://github.com/public'), b'ok')
        self.assertIsNone(request.call_args.args[0].get_header('Authorization'))
        self.assertEqual(request.call_args.kwargs['timeout'], 15)
        for body, url in [(b'x' * (1024 * 1024 + 1), 'https://github.com/large'), (b'ok', 'http://github.com/insecure')]:
            with patch.object(build, 'urlopen', return_value=Response(body, url)), self.assertRaises(ValueError):
                build.public_bytes('https://github.com/public')

    def test_uncertain_patch_is_not_retried_or_called_unpublished(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(build, 'run', side_effect=TimeoutError('secret response')) as mutate, \
                    patch.object(build, 'api') as read, self.assertRaisesRegex(ValueError, 'uncertain server state'):
                build.promote_draft(REPO, release(), root)
            self.assertEqual(mutate.call_count, 1)
            read.assert_not_called()
            self.assertEqual(build.load(root / 'publication-result.json')['state'], 'publication_unknown')
            self.assertTrue((root / 'publication-attempt.json').is_file())

    def test_public_failure_after_patch_preserves_published_state(self):
        for failure in ['api', 'public', 'wrong-latest']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                published = {**release(), 'draft': False}
                if failure == 'wrong-latest': published['id'] = 999
                with patch.object(build, 'run') as mutate, \
                        patch.object(build, 'api', side_effect=OSError() if failure == 'api' else None, return_value=published), \
                        patch.object(build, 'verify_public_channel', side_effect=OSError()), \
                        self.assertRaisesRegex(ValueError, 'already published'):
                    build.promote_draft(REPO, release(), root)
                self.assertEqual(mutate.call_count, 1)
                self.assertEqual(build.load(root / 'publication-result.json')['state'], 'published_but_unverified')

    def test_success_records_exact_release_and_public_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(build, 'run') as mutate, \
                    patch.object(build, 'api', return_value={**release(), 'draft': False}), \
                    patch.object(build, 'verify_public_channel', return_value={'authenticated': False, 'attempts': 1}):
                build.promote_draft(REPO, release(), root)
            self.assertEqual(mutate.call_count, 1)
            self.assertIn(f'repos/{REPO}/releases/12', mutate.call_args.args)
            result = build.load(root / 'publication-result.json')
            self.assertEqual(result['state'], 'published_and_verified')
            self.assertFalse(result['public']['authenticated'])

    def test_post_publication_asset_or_metadata_drift_is_not_a_verified_release(self):
        for field, value in [('tag_name', 'desktop-v0.9.0'), ('target_commitish', NEW_SHA), ('body', 'replaced'),
                             ('asset.id', 999), ('asset.size', 12345), ('asset.digest', 'sha256:' + NEW_SHA)]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                published = {**release(), 'draft': False}
                if field.startswith('asset.'):
                    published['assets'][0][field.split('.')[1]] = value
                else:
                    published[field] = value
                with patch.object(build, 'run') as mutate, patch.object(build, 'api', return_value=published), \
                        patch.object(build, 'verify_public_channel') as public, \
                        self.assertRaisesRegex(ValueError, 'already published'):
                    build.promote_draft(REPO, release(), root)
                self.assertEqual(mutate.call_count, 1)
                public.assert_not_called()
                self.assertEqual(build.load(root / 'publication-result.json')['state'], 'published_but_unverified')


class NativeRepetitions(unittest.TestCase):
    def fixtures(self, root):
        for name in ['ISOLATED_UNIX_UPDATE_ONLY', 'rehearsal.json', 'updater.pub', 'ca.pem', 'server.pem', 'server.key']:
            (root / name).write_text('{}', encoding='utf-8')
        for name in ['state', 'home', 'source']:
            (root / name).mkdir()
            (root / name / 'must-not-be-reused').write_text('private')

    def receipt(self):
        return {'status': 'passed', 'platform': 'linux-x86_64-appimage', 'version': '0.0.902', 'sha': SHA,
                'package_sha256': 'a' * 64, 'manifest_sha256': 'b' * 64, 'scope': 'isolated-production-handler-rehearsal'}

    def test_three_fresh_rounds_reuse_compiled_base_not_installation_or_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.fixtures(root)
            seen = []
            def execute(*args):
                directory = Path(args[args.index('--root') + 1])
                seen.append(directory)
                if directory != root:
                    for name in ['state', 'home', 'source', 'installed.AppImage']:
                        self.assertFalse((directory / name).exists())
                    if os.name == 'posix':
                        # Native Unix acceptance is OS-gated. Windows contract
                        # runners cannot represent POSIX permission bits.
                        self.assertEqual((directory / 'server.key').stat().st_mode & 0o777, 0o600)
                    self.assertEqual((directory / 'server.key').read_bytes(), (root / 'server.key').read_bytes())
                self.assertEqual(args[args.index('--base') + 1], 'untouched-base')
                build.write(directory / 'acceptance.json', self.receipt())
            with patch.object(build, 'run', side_effect=execute):
                build.run_native_rounds(['native', '--root', root, '--base', 'untouched-base'], root)
            self.assertEqual(seen, [root, root / 'repetitions/2', root / 'repetitions/3'])
            summary = build.load(root / 'repetition-summary.json')
            self.assertEqual(summary['status'], 'passed')
            self.assertEqual(len(summary['completed']), 3)

    def test_later_failure_or_changed_candidate_invalidates_first_acceptance(self):
        for failure in ['runtime', 'identity']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); self.fixtures(root)
                def execute(*args):
                    directory = Path(args[args.index('--root') + 1])
                    receipt = self.receipt()
                    if directory != root:
                        if failure == 'runtime': raise RuntimeError('native restart failed')
                        receipt['package_sha256'] = 'c' * 64
                    build.write(directory / 'acceptance.json', receipt)
                with patch.object(build, 'run', side_effect=execute), self.assertRaises((ValueError, RuntimeError)):
                    build.run_native_rounds(['native', '--root', root], root)
                self.assertFalse((root / 'acceptance.json').exists())
                summary = build.load(root / 'repetition-summary.json')
                self.assertEqual(summary['status'], 'failed')
                self.assertEqual(len(summary['completed']), 1)

    def test_repeat_export_retains_only_public_evidence_never_runtime_keys(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary) / 'root', Path(temporary) / 'output'
            root.mkdir()
            repeat = root / 'repetitions/2'; repeat.mkdir(parents=True)
            for name in ['acceptance.json', 'evidence.json', 'server.key', 'ca.pem', 'rehearsal.json']:
                (repeat / name).write_text('{}')
            build.export_native(type('Args', (), {'root': root, 'output': output})())
            self.assertEqual({p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()},
                             {'repetitions/2/acceptance.json', 'repetitions/2/evidence.json'})


class NativeCargoCache(unittest.TestCase):
    def test_prepare_exports_original_checkout_cache_without_touching_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            checkout, candidate, isolated = root / 'checkout', root / 'candidate', root / 'isolated'
            (checkout / 'apps/desktop/src-tauri/target').mkdir(parents=True)
            (candidate / 'release').mkdir(parents=True)
            isolated.mkdir()
            (candidate / 'plan.json').write_text(json.dumps({'version': '0.2.6'}), encoding='utf-8')
            package = candidate / 'release/immutable.AppImage'
            package.write_bytes(b'signed production bytes')
            (isolated / 'build-env.json').write_text(json.dumps({'XHARNESS_UPDATER_ENDPOINT': 'https://localhost:123/latest.json',
                'XHARNESS_UPDATER_PUBKEY': 'public-fixture'}), encoding='utf-8')
            args = type('Args', (), {'candidate': candidate, 'root': isolated, 'platform': 'linux-x86_64-appimage'})()
            with patch.object(build, 'ROOT', checkout), patch.object(build, 'run') as run, \
                    patch.object(build, 'export_environment') as export:
                build.prepare_native(args)
            expected = str(checkout / 'apps/desktop/src-tauri/target')
            self.assertEqual(export.call_args.args[0]['CARGO_TARGET_DIR'], expected)
            self.assertTrue(Path(expected).is_absolute())
            self.assertEqual(export.call_args.args[0]['XHARNESS_UPDATER_PUBKEY'], 'public-fixture')
            self.assertNotIn(str(isolated / 'source'), expected)
            self.assertEqual(package.read_bytes(), b'signed production bytes')
            self.assertIn('prepare', run.call_args.args)

    def test_native_run_reads_base_from_shared_cache_but_candidate_from_immutable_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            checkout, candidate, isolated = root / 'checkout', root / 'candidate', root / 'isolated'
            (checkout / 'apps/desktop/src-tauri/target').mkdir(parents=True)
            (candidate / 'release').mkdir(parents=True)
            isolated.mkdir()
            (isolated / 'rehearsal.json').write_text(json.dumps({'platform': 'linux-x86_64-appimage'}), encoding='utf-8')
            name = 'XHarness_0.2.6_amd64.AppImage'
            (candidate / 'release/linux-x86_64-appimage.receipt.json').write_text(json.dumps({'package': name}), encoding='utf-8')
            package = candidate / 'release' / name
            package.write_bytes(b'unchanged candidate')
            args = type('Args', (), {'candidate': candidate, 'root': isolated, 'rehearsal': False})()
            with patch.object(build, 'ROOT', checkout), patch.object(build, 'run_native_rounds') as run:
                build.native_run(args)
            command = run.call_args.args[0]
            self.assertEqual(command[command.index('--base') + 1], checkout / 'apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/XHarness_0.0.901_amd64.AppImage')
            self.assertEqual(command[command.index('--candidate') + 1], package)
            self.assertEqual(package.read_bytes(), b'unchanged candidate')

    def test_shared_cache_cannot_overlap_candidate_or_redirect_to_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            checkout = root / 'checkout'
            desktop = checkout / 'apps/desktop/src-tauri'
            desktop.mkdir(parents=True)
            target = desktop / 'target'
            with patch.object(build, 'ROOT', checkout):
                self.assertEqual(build.native_target_dir(root / 'safe-candidate'), target)
                for candidate in [target, desktop, target / 'release/candidate']:
                    with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                        build.native_target_dir(candidate)
                # This guard is platform-independent; Windows test users need no
                # symlink creation privilege to verify the rejection contract.
                with patch.object(Path, 'is_symlink', return_value=True), self.assertRaises(ValueError):
                    build.native_target_dir(root / 'safe-candidate')


class WorkflowGuard(unittest.TestCase):
    def test_single_aggregate_writer_and_four_native_platforms(self):
        text = (ROOT / '.github/workflows/desktop-release.yml').read_text(encoding='utf-8')
        self.assertEqual(text.count('contents: write'), 1)
        self.assertIn('needs: [plan, build]', text)
        self.assertNotIn('tauri-apps/tauri-action', text)
        self.assertNotIn('--clobber', text)
        self.assertIn('fromJSON(needs.plan.outputs.matrix)', text)
        self.assertIn("inputs.release_scope || 'all'", text)
        self.assertIn('signing-plan --plan dist/desktop-plan/plan.json', text)
        matrix = build.platform_matrix({})
        self.assertEqual({p['platform'] for p in matrix['include']}, set(build.PLATFORMS))
        self.assertEqual({p['runner'] for p in matrix['include']}, {'windows-2025', 'ubuntu-22.04', 'macos-15', 'macos-15-intel'})
        self.assertIn('appimage', {p['bundles'] for p in matrix['include']})
        self.assertNotIn('bundles: deb', text)
        self.assertIn('XHARNESS_FRIENDS_PRIVATE_KEY', text)
        self.assertIn('Fail early unless every formal platform', text)

    def test_promotion_only_and_shared_serialization(self):
        for name in ['desktop-release.yml', 'desktop-promote.yml', 'friends-release.yml']:
            self.assertIn('group: desktop-stable-release', (ROOT / '.github/workflows' / name).read_text(encoding='utf-8'))
        promote = (ROOT / '.github/workflows/desktop-promote.yml').read_text(encoding='utf-8')
        for guard in ['refs/heads/master', 'resolve-source', 'fetch-promotion', 'publish --workspace']:
            self.assertIn(guard, promote)

    def test_rehearsal_cannot_be_mistaken_for_formal_acceptance(self):
        text = (ROOT / '.github/workflows/desktop-unix-update-acceptance.yml').read_text(encoding='utf-8')
        self.assertIn('workflow_call:', text)
        self.assertIn('default: rehearsal', text)
        self.assertIn('actions/setup-python@v5', text)
        self.assertIn("python-version: '3.12'", text)
        self.assertIn("inputs.mode == 'candidate' && 'acceptance' || 'rehearsal'", text)
        self.assertNotIn('contents: write', text)
        self.assertNotIn('XHARNESS_FRIENDS_PRIVATE_KEY', text)
        self.assertNotIn('APPLE_CERTIFICATE', text)
        self.assertIn('--rehearsal', text)
        for platform in ['linux-x86_64-appimage', 'darwin-aarch64', 'darwin-x86_64']:
            self.assertIn(platform, {p['platform'] for p in build.platform_matrix({}, unix_only=True)['include']})

    def test_exported_evidence_excludes_keys_source_and_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, output = Path(temporary) / 'root', Path(temporary) / 'output'
            root.mkdir()
            for name in ['acceptance.json', 'app.log', 'cleanup.json', 'tls.key', 'ca.pem', 'disposable.key', 'providers.json']:
                (root / name).write_text('{}')
            build.export_native(type('Args', (), {'root': root, 'output': output})())
            self.assertEqual({p.name for p in output.iterdir()}, {'acceptance.json', 'app.log', 'cleanup.json'})


if __name__ == '__main__':
    unittest.main()
