#!/usr/bin/env python3
"""Offline archive, pin, manifest, bot and packaging regression. No Rust build."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


runtime = module('runtime', 'powershell-runtime.py')
publisher = module('publisher', 'publish-powershell-upgrade.py')
pe_fixtures = module('pe_fixtures', 'test-windows-runtime-audit.py')
CURRENT = runtime.load_lock()['version']
SERIES = runtime.load_lock()['lts_series']
PATCH = int(CURRENT.split('.')[-1])
NEXT = SERIES + '.' + str(PATCH + 1)
LATER = SERIES + '.' + str(PATCH + 2)
OLDER = SERIES + '.' + str(max(0, PATCH - 1))
BOT_BRANCH = 'bot/powershell-' + NEXT


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / 'pwsh.zip'
        self.output = self.root / 'resources with spaces/powershell'

    def make(self, *, extras=None, omit=(), version=CURRENT):
        with zipfile.ZipFile(self.archive, 'w', zipfile.ZIP_DEFLATED) as z:
            for name in runtime.CORE:
                if name not in omit:
                    z.writestr(name, pe_fixtures.fixture() if name in runtime.NATIVE else b'fixture')
            for name, value in (extras or []):
                if isinstance(name, str):
                    # ZipInfo also normalizes Windows separators when writing.
                    # Emit the actual malicious central-directory bytes so the
                    # regression is not accidentally a valid a/b file on Win.
                    info = zipfile.ZipInfo(name)
                    info.filename = name
                    name = info
                z.writestr(name, value)
        lock = copy.deepcopy(runtime.load_lock())
        lock['version'] = version
        lock['archives'][runtime.TARGET] = {'sha256': runtime.digest(self.archive), 'size': self.archive.stat().st_size}
        return lock

    def stage(self, lock):
        return runtime.stage(self.output, lock=lock, archive=self.archive)

    def test_full_bundle_spaces_manifest_licenses_idempotent_no_download(self):
        lock = self.make(extras=[('Modules/Test/module.psm1', b'module')])
        with patch.object(runtime, 'download', side_effect=AssertionError('offline')):
            first = self.stage(lock)
            self.assertEqual(first, self.stage(lock))
        self.assertEqual(len(first['files']), len(runtime.CORE) + 1)
        self.assertEqual(first['native_modules'], sorted(runtime.NATIVE))
        self.assertTrue((self.output / lock['version'] / 'ThirdPartyNotices.txt').is_file())
        self.assertEqual(runtime.verify(self.output, lock, first['manifest_sha256']), first)

    def test_bad_digest_and_size_cannot_publish_partial_output(self):
        for field in ['sha256', 'size']:
            lock = self.make()
            lock['archives'][runtime.TARGET][field] = '0' * 64 if field == 'sha256' else lock['archives'][runtime.TARGET]['size'] + 1
            with self.assertRaisesRegex(ValueError, 'SHA256/size'):
                self.stage(lock)
            self.assertFalse(self.output.exists())

    def test_atomic_download_publication_stays_on_cache_filesystem(self):
        import shutil
        lock = self.make()
        cache = self.root / 'other volume/cache'
        real_replace = runtime.os.replace
        def replace(source, destination):
            self.assertTrue(Path(source).is_relative_to(cache), 'cross-volume atomic move')
            self.assertEqual(Path(destination).parent, cache)
            return real_replace(source, destination)
        def download(url, destination, limit):
            shutil.copyfile(self.archive, destination)
        with patch.object(runtime, 'download', side_effect=download), patch.object(runtime.os, 'replace', side_effect=replace):
            receipt = runtime.stage(self.output, lock=lock, cache=cache)
        self.assertEqual(receipt['version'], CURRENT)

    def test_missing_core_and_license_rejected(self):
        for name in runtime.CORE:
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'Incomplete'):
                    self.stage(self.make(omit=[name]))
                self.assertFalse(self.output.exists())

    def test_path_traversal_absolute_backslash_ads_devices_and_collision(self):
        names = ['../outside', '/absolute', 'C:/drive', 'a\\b', 'pwsh.exe:stream',
                 'CON', 'dir/NUL.txt', 'dir/trailing.', 'dir/trailing ', 'PWSh.EXE', 'bad\x01name']
        for name in names:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.stage(self.make(extras=[(name, b'bad')]))
            self.assertFalse(self.output.exists())
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.stage(self.make(extras=[('dir', b'file'), ('dir/file', b'bad')]))

    def test_zip_symlink_and_budget_rejected(self):
        link = zipfile.ZipInfo('redirect')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaisesRegex(ValueError, 'Redirecting'):
            self.stage(self.make(extras=[(link, b'../outside')]))
        lock = self.make()
        with patch.object(runtime, 'MAX_EXPANDED', 10), self.assertRaisesRegex(ValueError, 'budget'):
            self.stage(lock)

    def test_changed_deleted_unmanifested_and_mixed_files_are_rejected(self):
        lock = self.make()
        self.stage(lock)
        exe = self.output / lock['version'] / 'pwsh.exe'
        original = exe.read_bytes()
        exe.write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'Corrupt/missing'):
            runtime.verify(self.output, lock)
        exe.write_bytes(original)
        extra = exe.parent / 'unexpected.dll'
        extra.write_bytes(b'untrusted')
        with self.assertRaisesRegex(ValueError, 'Unmanifested'):
            runtime.verify(self.output, lock)
        extra.unlink()
        with self.assertRaisesRegex(ValueError, 'mixed.*manifest'):
            runtime.verify(self.output, lock, '0' * 64)
        exe.unlink()
        with self.assertRaisesRegex(ValueError, 'Corrupt/missing'):
            self.stage(lock)  # damaged existing runtime is never overwritten

    def test_redirect_in_extracted_tree_rejected(self):
        lock = self.make()
        self.stage(lock)
        path = self.output / lock['version'] / 'LICENSE.txt'
        path.unlink()
        try:
            path.symlink_to(self.archive)
        except OSError:
            self.skipTest('symlinks unavailable on this platform')
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            runtime.verify(self.output, lock)

    def test_wrong_native_architecture_and_unpackaged_dependency(self):
        for fixture in [pe_fixtures.fixture(machine=0x14c, pe32=True), pe_fixtures.fixture(imports=('vcruntime140.dll',))]:
            lock = self.make()
            # Replace the archive, not a successfully staged payload.
            with zipfile.ZipFile(self.archive, 'w') as z:
                for name in runtime.CORE:
                    z.writestr(name, fixture if name == 'pwsh.exe' else pe_fixtures.fixture() if name in runtime.NATIVE else b'fixture')
            lock['archives'][runtime.TARGET] = {'sha256': runtime.digest(self.archive), 'size': self.archive.stat().st_size}
            with self.assertRaises(ValueError):
                self.stage(lock)
            self.assertFalse(self.output.exists())


class UpgradeTests(unittest.TestCase):
    def release(self, version=NEXT, **kwargs):
        lock = copy.deepcopy(runtime.load_lock())
        lock['version'] = version
        result = dict(tag_name='v' + version, draft=False, prerelease=False, assets=[{
            'name': runtime.asset_name(lock), 'digest': 'sha256:' + 'a' * 64, 'size': 100,
            'browser_download_url': runtime.release_url(lock)}])
        result.update(kwargs)
        return result

    def test_only_new_same_lts_patch_not_major_preview_draft_downgrade(self):
        lock = runtime.load_lock()
        rejected = [self.release('8.0.0'), self.release('7.7.0'), self.release(OLDER),
                    self.release(LATER, prerelease=True), self.release(LATER, draft=True)]
        self.assertIsNone(runtime.proposed_lock(lock, rejected))
        candidate = runtime.proposed_lock(lock, rejected + [self.release(), self.release(LATER)])
        self.assertEqual(candidate['version'], LATER)
        self.assertEqual(candidate['archives'][runtime.TARGET]['sha256'], 'a' * 64)

    def test_ambiguous_missing_hash_arbitrary_url_size_fail_closed(self):
        for change in [dict(digest=None), dict(digest='sha256:bad'), dict(size=0), dict(size=True),
                       dict(browser_download_url='https://untrusted.example/pwsh.zip')]:
            release = self.release()
            release['assets'][0].update(change)
            with self.assertRaises(ValueError):
                runtime.proposed_lock(runtime.load_lock(), [release])
        for assets in [[], self.release()['assets'] * 2]:
            with self.assertRaises(ValueError):
                runtime.proposed_lock(runtime.load_lock(), [self.release(assets=assets)])

    def test_lock_rejects_extra_url_non_stable_wrong_target_and_unbounded_size(self):
        for edit in [lambda l: l.update(url='https://evil'), lambda l: l.update(version='7.6.7-preview'),
                     lambda l: l.update(lts_series='7.5'), lambda l: l['archives'].update(arm64={}),
                     lambda l: l['archives'][runtime.TARGET].update(size=runtime.MAX_ARCHIVE+1)]:
            lock = copy.deepcopy(runtime.load_lock())
            edit(lock)
            with self.assertRaises(ValueError):
                runtime.validate_lock(lock)

    def test_publish_only_one_lock_file_and_dispatch_ci_never_merge(self):
        candidate = runtime.proposed_lock(runtime.load_lock(), [self.release()])
        calls = []
        def api(path, method='GET', body=None, **kwargs):
            calls.append((path, method, body))
            if path.endswith('/git/ref/heads/' + BOT_BRANCH):
                return None
            if '/contents/' in path and method == 'GET':
                return {'sha': 'f' * 40}
            if path.endswith('/pulls'):
                return {'html_url': 'https://github.com/owner/repo/pull/1', 'head': {'sha': 'c' * 40}}
            if '/runs?' in path:
                return {'workflow_runs': []}
        with patch.object(publisher, 'api', side_effect=api):
            publisher.publish(candidate, 'owner/repo', 'b' * 40)
        mutations = [c for c in calls if c[1] != 'GET']
        self.assertEqual([c[1] for c in mutations], ['POST', 'PUT', 'POST', 'POST', 'POST'])
        self.assertTrue(mutations[1][0].endswith('/contents/runtime/powershell.lock.json'))
        self.assertTrue(mutations[-2][0].endswith('/ci.yml/dispatches'))
        self.assertTrue(all('merge' not in c[0] and 'review' not in c[0] for c in calls))

    def test_existing_open_pr_does_not_duplicate_or_retrigger_ci(self):
        candidate = runtime.proposed_lock(runtime.load_lock(), [self.release()])
        with patch.object(publisher, 'api', side_effect=[{'object': {}}, [{'state':'open', 'html_url':'existing', 'head':{'sha':'c'*40}}], {'workflow_runs':[{}]}, {'workflow_runs':[{}]}]) as api:
            publisher.publish(candidate, 'owner/repo', 'b' * 40)
        self.assertEqual(api.call_count, 4)

    def test_partial_ci_dispatch_recovers_only_missing_native_run(self):
        with patch.object(publisher, 'api', side_effect=[{'workflow_runs':[{}]}, {'workflow_runs':[]}, None]) as api:
            publisher.request_checks('repos/owner/repo', BOT_BRANCH, 'c' * 40)
        self.assertEqual(api.call_count, 3)
        self.assertIn('windows-runtime-gates.yml/dispatches', api.call_args.args[0])

    def test_partial_commit_recovers_pr_without_second_commit(self):
        import base64
        candidate = runtime.proposed_lock(runtime.load_lock(), [self.release()])
        replies = [{'object':{'sha':'c'*40}}, [],
                   {'sha':'f'*40, 'content':base64.b64encode(json.dumps(candidate).encode()).decode()},
                   {'files':[{'filename':'runtime/powershell.lock.json'}]},
                   {'html_url':'recovered','head':{'sha':'c'*40}},
                   {'workflow_runs':[]}, None, {'workflow_runs':[]}, None]
        with patch.object(publisher, 'api', side_effect=replies) as api:
            publisher.publish(candidate, 'owner/repo', 'b' * 40)
        self.assertFalse(any(call.args[1:2] == ('PUT',) for call in api.call_args_list))

    def test_closed_pr_is_not_reopened_or_retested(self):
        candidate = runtime.proposed_lock(runtime.load_lock(), [self.release()])
        with patch.object(publisher, 'api', side_effect=[{'object': {}}, [{'state':'closed', 'html_url':'closed'}]]) as api:
            publisher.publish(candidate, 'owner/repo', 'b' * 40)
        self.assertEqual(api.call_count, 2)

    def test_no_upgrade_does_not_download_or_write(self):
        with tempfile.TemporaryDirectory() as t, patch.object(runtime.subprocess, 'run') as run, patch.object(runtime, 'download', side_effect=AssertionError('unnecessary download')):
            run.return_value.stdout = json.dumps([self.release(CURRENT)])
            out = Path(t) / 'proposal.json'
            self.assertFalse(runtime.check_updates(runtime.LOCK, out))
            self.assertFalse(out.exists())


class WiringTests(unittest.TestCase):
    def test_all_windows_sidecar_routes_stage_resources(self):
        for name in ['ci.yml', 'friends-release.yml', 'desktop-windows-cache-rehearsal.yml']:
            lines = (ROOT / '.github/workflows' / name).read_text().splitlines()
            for index, line in enumerate(lines):
                if 'scripts/stage-tauri-sidecar.py' in line and 'xharness-host.exe' in line:
                    self.assertIn('if ($LASTEXITCODE)', lines[index+1])
                    self.assertIn('scripts/powershell-runtime.py stage', lines[index+2], name)
                    self.assertIn('if ($LASTEXITCODE)', lines[index+3])
        builder = (ROOT / 'scripts/desktop-release-build.py').read_text()
        self.assertIn("'scripts/powershell-runtime.py', 'stage'", builder)

    def test_windows_only_overlay_keeps_web_and_does_not_register_a_shell_tool(self):
        overlay = json.loads((ROOT / 'apps/desktop/src-tauri/tauri.windows.conf.json').read_text())
        self.assertEqual(overlay['bundle']['resources']['resources/powershell/'], 'runtime/powershell/')
        self.assertEqual(overlay['bundle']['resources']['../../../ui/dist/'], 'web/')
        self.assertEqual(len(overlay['bundle']['externalBin']), 3)
        base = (ROOT / 'apps/desktop/src-tauri/tauri.conf.json').read_text()
        self.assertNotIn('powershell', base)

    def test_bot_trusted_schedule_no_auto_merge_and_ci_dispatch_has_pr_smoke(self):
        source = (ROOT / '.github/workflows/powershell-dependency-update.yml').read_text()
        self.assertIn("github.ref == 'refs/heads/master'", source)
        self.assertNotIn('pull_request_target:', source)
        self.assertNotIn('PAT', source)
        self.assertIn('persist-credentials: false', source)
        ci = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn('  workflow_dispatch:', ci)
        start = ci.index('      - name: Stage debug Windows sidecars for PR smoke')
        self.assertIn("github.event_name == 'workflow_dispatch'", ci[start:start+200])
        bot = (ROOT / 'scripts/publish-powershell-upgrade.py').read_text()
        self.assertNotIn("'/merge'", bot)
        self.assertTrue((ROOT / '.github/dependabot.yml').is_file())


if __name__ == '__main__':
    unittest.main()
