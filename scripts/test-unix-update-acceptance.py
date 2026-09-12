#!/usr/bin/env python3
"""Executable harness regression tests. No Rust compilation or native-acceptance claims."""
import argparse
import base64
import contextlib
import hashlib
import http.server
import importlib.util
import io
import json
import os
import pathlib
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('unix_acceptance', HERE / 'unix-update-acceptance.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class HarnessTests(unittest.TestCase):
    def test_native_signature_delegates_explicit_policy_and_checks_version(self):
        info = {'CFBundleShortVersionString': '0.2.19'}
        for preview in (False, True):
            with patch.object(m, 'mac_binary', return_value=(pathlib.Path('binary'), info)), \
                    patch.object(m._macos_signing, 'verify', return_value={'codesignVerified': True}) as verify:
                self.assertEqual(m.native_signature(pathlib.Path('app'), '0.2.19', pathlib.Path('evidence'), preview=preview),
                                 {'codesignVerified': True})
                verify.assert_called_once_with(pathlib.Path('app'), preview=preview, evidence=pathlib.Path('evidence'))
        with patch.object(m, 'mac_binary', return_value=(pathlib.Path('binary'), info)), \
                patch.object(m._macos_signing, 'verify') as verify, self.assertRaises(ValueError):
            m.native_signature(pathlib.Path('app'), '0.2.18', pathlib.Path('evidence'), preview=True)
        verify.assert_not_called()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='unix-harness-unit-')
        self.directory = pathlib.Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def root(self):
        return m.isolated_root(self.directory / 'isolated', create=True)

    def archive(self, entries):
        path = self.directory / 'test.app.tar.gz'
        with tarfile.open(path, 'w:gz') as stream:
            for name, kind, value in entries:
                item = tarfile.TarInfo(name)
                if kind == 'link':
                    item.type = tarfile.SYMTYPE
                    item.linkname = value
                    stream.addfile(item)
                else:
                    item.mode = 0o755
                    data = value.encode()
                    item.size = len(data)
                    stream.addfile(item, io.BytesIO(data))
        return path

    def key_material(self):
        # Independent Node Ed25519 signer to test real Minisign verification.
        code = r"""
const {generateKeyPairSync,sign,createHash}=require('node:crypto');
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const id=Buffer.alloc(8,17),payload=Buffer.from('unit signed package'),comment='timestamp:1';
const key=Buffer.concat([Buffer.from('Ed'),id,publicKey.export({format:'der',type:'spki'}).subarray(-32)]);
const sig=sign(null,createHash('blake2b512').update(payload).digest(),privateKey);
const global=sign(null,Buffer.concat([sig,Buffer.from(comment)]),privateKey);
const b64=s=>Buffer.from(s).toString('base64');
process.stdout.write(JSON.stringify({payload:payload.toString(),key:b64('untrusted comment: key\n'+key.toString('base64')+'\n'),
signature:b64('untrusted comment: sig\n'+Buffer.concat([Buffer.from('ED'),id,sig]).toString('base64')+'\ntrusted comment: '+comment+'\n'+global.toString('base64')+'\n')}));
"""
        values = json.loads(m.run(['node', '-e', code]).stdout)
        asset = self.directory / 'XHarness_0.2.6_amd64.AppImage'
        asset.write_text(values['payload'])
        sig = self.directory / 'package.sig'
        sig.write_text(values['signature'])
        pub = self.directory / 'updater.pub'
        pub.write_text(values['key'])
        return asset, sig, pub

    def receipt(self):
        asset, sig, pub = self.key_material()
        receipt = {'schema_version': 1, 'platform': 'linux-x86_64-appimage',
                   'target': 'x86_64-unknown-linux-gnu', 'package': asset.name,
                   'package_sha256': m.digest(asset), 'package_size': asset.stat().st_size,
                   'signature': sig.read_text(), 'public_key_sha256': m.public_key_digest(pub),
                   'identifier': 'com.xlang.xharness', 'sha': 'a' * 40, 'version': '0.2.6',
                   'release_run_id': '123', 'release_run_attempt': '1',
                   'repository': 'fixture/repository', 'tag': 'desktop-v0.2.6',
                   'embedded_endpoint': 'https://github.com/fixture/repository/releases/latest/download/latest.json'}
        receipt_path = self.directory / 'receipt.json'
        m.write_json(receipt_path, receipt)
        manifest = self.directory / 'latest.json'
        m.write_json(manifest, {'version': '0.2.6', 'platforms': {'linux-x86_64-appimage': {
            'signature': sig.read_text(), 'url': 'https://github.com/fixture/repository/releases/download/desktop-v0.2.6/' + asset.name}}})
        args = argparse.Namespace(candidate=str(asset), signature=str(sig), public_key=str(pub),
                                  receipt=str(receipt_path), manifest=str(manifest), platform='linux-x86_64-appimage')
        return args, receipt

    def test_local_native_execution_is_refused_before_launch(self):
        env = dict(os.environ, GITHUB_ACTIONS='false')
        result = subprocess.run([sys.executable, str(HERE / 'unix-update-acceptance.py'),
            'candidate-native', '--platform', 'darwin-aarch64', '--asset', 'missing',
            '--signature', 'missing', '--public-key', 'missing', '--receipt', 'missing',
            '--manifest', 'missing', '--evidence-dir', str(self.directory / 'new')],
            env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('disposable GitHub-hosted', result.stderr)
        self.assertFalse((self.directory / 'new').exists())

    def test_hosted_architecture_guard(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}), \
                patch.object(m.sys, 'platform', 'darwin'), patch.object(m.platform, 'machine', return_value='arm64'):
            m.native_runner('darwin-aarch64')
            with self.assertRaisesRegex(ValueError, 'architecture mismatch'):
                m.native_runner('darwin-x86_64')

    def test_isolation_refuses_existing_symlink_and_world_writable(self):
        root = self.root()
        with self.assertRaises(FileExistsError):
            m.isolated_root(root, create=True)
        link = self.directory / 'link'
        link.symlink_to(root)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            m.isolated_root(link)
        root.chmod(0o755)
        with self.assertRaisesRegex(ValueError, '0700'):
            m.isolated_root(root)

    def test_runtime_is_allowlisted_and_data_is_synthetic(self):
        root = self.root()
        retained = m.create_data(root)
        with patch.dict(os.environ, {'UNUSUAL_CREDENTIAL': 'never-inherit', 'GH_TOKEN': 'secret',
                'XHARNESS_PROVIDERS_FILE': '/real/providers.json', 'PYTHONHOME': '/real/python'}):
            env = m.runtime_environment(root)
        for key in ('UNUSUAL_CREDENTIAL', 'GH_TOKEN', 'PYTHONHOME'):
            self.assertNotIn(key, env)
        self.assertEqual(env['HOME'], str(root / 'home'))
        self.assertEqual(env['CFFIXED_USER_HOME'], env['HOME'])
        self.assertEqual(env['XHARNESS_PROVIDERS_FILE'], str(root / 'config/providers.json'))
        self.assertGreaterEqual(len(retained), 7)
        self.assertTrue(all(m.digest(root / p) == value for p, value in retained.items()))

    def test_jsonl_partial_tail_is_not_false_failure(self):
        path = self.directory / 'events.jsonl'
        path.write_text('{"first":true}\n{"second":')
        self.assertEqual(m.json_lines(path), [{'first': True}])
        path.write_text('{invalid}\n')
        with self.assertRaises(json.JSONDecodeError):
            m.json_lines(path)

    def test_archive_preserves_internal_symlinks_and_executable_modes(self):
        asset = self.archive([('XHarness.app/Contents/Frameworks/Version/A/lib', 'file', 'library'),
                              ('XHarness.app/Contents/Frameworks/Version/Current', 'link', 'A')])
        root = m.safe_extract_app(asset, self.directory / 'extracted')
        self.assertEqual((root / 'Contents/Frameworks/Version/Current/lib').read_text(), 'library')
        one = m.tree_digest(root)
        (root / 'Contents/Frameworks/Version/A/lib').chmod(0o644)
        self.assertNotEqual(one, m.tree_digest(root))

    def test_archive_rejects_traversal_links_duplicates_and_multiple_apps(self):
        cases = [
            [('XHarness.app/../../escape', 'file', 'bad')],
            [('XHarness.app/link', 'link', '/Applications')],
            [('XHarness.app/link', 'link', '../../escape')],
            [('XHarness.app/link', 'link', 'data'), ('XHarness.app/link/overwritten', 'file', 'bad')],
            [('XHarness.app/same', 'file', '1'), ('XHarness.app/same', 'file', '2')],
            [('XHarness.app/a', 'file', '1'), ('Other.app/b', 'file', '2')],
        ]
        for index, entries in enumerate(cases):
            with self.subTest(index=index), self.assertRaises(ValueError):
                m.safe_extract_app(self.archive(entries), self.directory / ('extract-' + str(index)))
        self.assertFalse((self.directory / 'escape').exists())

    def test_receipt_signature_manifest_and_key_are_actually_verified(self):
        args, receipt = self.receipt()
        self.assertEqual(m.verify_receipt(args), receipt)
        pathlib.Path(args.candidate).write_text('corruption')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            m.verify_receipt(args)
        # Corrupt bytes even if a malicious receipt was rehashed: signature fails.
        receipt['package_sha256'] = m.digest(args.candidate)
        receipt['package_size'] = pathlib.Path(args.candidate).stat().st_size
        m.write_json(args.receipt, receipt)
        with self.assertRaises(subprocess.CalledProcessError):
            m.verify_receipt(args)

    def test_receipt_rejects_other_arch_and_live_url(self):
        args, receipt = self.receipt()
        receipt['platform'] = 'darwin-aarch64'
        m.write_json(args.receipt, receipt)
        with self.assertRaisesRegex(ValueError, 'platform mismatch'):
            m.verify_receipt(args)
        receipt['platform'] = args.platform
        m.write_json(args.receipt, receipt)
        manifest = m.read_json(args.manifest)
        manifest['platforms'][args.platform]['url'] = 'https://untrusted.example/payload'
        m.write_json(args.manifest, manifest)
        with self.assertRaisesRegex(ValueError, 'URL mismatch'):
            m.verify_receipt(args)

    def test_ready_never_connects_outside_loopback(self):
        root = self.root()
        m.create_data(root)
        path = root / 'cache/ready-test.address'
        path.write_text('10.0.0.1:8000')
        with self.assertRaisesRegex(ValueError, 'outside loopback'):
            m.healthy_ready(root)

    def stopped_session_snapshot(self, root):
        # Execute the actual embedded snapshot subprocess, without Rust/native
        # builds. Native CI separately proves the Host shutdown call boundary.
        fixture = (HERE / 'fixtures/unix-update-driver.rs').read_text()
        body = fixture.split('pub fn snapshot_before_install()', 1)[1].split('pub async fn run', 1)[0]
        program = body.split('r#"', 1)[1].split('"#', 1)[0]
        output = m.run([sys.executable, '-E', '-c', program],
                       env={**os.environ, 'XHARNESS_REHEARSAL_ROOT': str(root)})
        return json.loads(output.stdout)

    def test_replay_requires_new_host_exact_inventory_and_successful_restore(self):
        root = self.root()
        m.create_data(root)
        journals = root / 'state/sessions'
        journals.mkdir()
        (journals / (m.SESSION + '.jsonl')).write_text('synthetic known journal\n')
        trace = root / 'trace/new'
        trace.mkdir()
        events = trace / 'events.jsonl'
        ready = root / 'cache/new.address'
        start = {'layer': 'host', 'event': 'start', 'payload': {'readyFile': str(ready), 'stateDir': str(root / 'state')}}
        restore = {'layer': 'host', 'event': 'restore', 'payload': {'restoredSessions': 1, 'issues': []}}
        before = self.stopped_session_snapshot(root)
        events.write_text(json.dumps(start) + '\n' + json.dumps(restore) + '\n')
        self.assertEqual(m.restored_candidate(root, ready, before)['restoredSessions'], 1)
        self.assertIsNone(m.restored_candidate(root, root / 'old.address', before))
        start['payload']['stateDir'] = str(root / 'wrong-state')
        events.write_text(json.dumps(start) + '\n' + json.dumps(restore) + '\n')
        self.assertIsNone(m.restored_candidate(root, ready, before))
        start['payload']['stateDir'] = str(root / 'state')

        # CI reproduced an untouched UI-created second session. Require all
        # journals, not count == 1 and not the too-permissive count >= 1.
        (journals / 'ui-created-session.jsonl').write_text('synthetic UI journal\n')
        before = self.stopped_session_snapshot(root)
        restore['payload']['restoredSessions'] = 2
        events.write_text(json.dumps(start) + '\n' + json.dumps(restore) + '\n')
        replay = m.restored_candidate(root, ready, before)
        self.assertEqual(replay['restoredSessions'], 2)
        self.assertEqual(replay['knownSession'], m.SESSION)
        self.assertEqual(replay['sessionInventory'], before['sessionInventory'])
        for incorrect in (0, 1, 3, True, None):
            restore['payload']['restoredSessions'] = incorrect
            events.write_text(json.dumps(start) + '\n' + json.dumps(restore) + '\n')
            self.assertIsNone(m.restored_candidate(root, ready, before))
        restore['payload'].update(restoredSessions=2, issues=['corrupt journal'])
        events.write_text(json.dumps(start) + '\n' + json.dumps(restore) + '\n')
        self.assertIsNone(m.restored_candidate(root, ready, before))

    def test_snapshot_inventory_rejects_lost_changed_or_unbound_known_session(self):
        root = self.root()
        m.create_data(root)
        journals = root / 'state/sessions'
        journals.mkdir()
        known = journals / (m.SESSION + '.jsonl')
        known.write_text('known bytes\n')
        before = self.stopped_session_snapshot(root)
        self.assertEqual(m.validated_snapshot_inventory(before), m.session_inventory(root))
        invalid = dict(before, hostStoppedBeforeSnapshot=False)
        with self.assertRaisesRegex(ValueError, 'shutdown barrier'):
            m.validated_snapshot_inventory(invalid)
        invalid = dict(before, sessionInventory={})
        with self.assertRaisesRegex(ValueError, 'known session'):
            m.validated_snapshot_inventory(invalid)
        invalid = dict(before, journalBase64=base64.b64encode(b'other bytes').decode())
        with self.assertRaisesRegex(ValueError, 'do not match'):
            m.validated_snapshot_inventory(invalid)
        for other in ('../escape.jsonl', 'directory/escape.jsonl', 'not-a-journal.txt'):
            invalid = dict(before, sessionInventory={**before['sessionInventory'], other: 'a' * 64})
            with self.assertRaisesRegex(ValueError, 'Invalid snapshot'):
                m.validated_snapshot_inventory(invalid)
        known.write_text('changed bytes\n')
        with self.assertRaisesRegex(ValueError, 'inventory changed'):
            m.restored_candidate(root, root / 'ready.address', before)
        known.unlink()
        with self.assertRaisesRegex(ValueError, 'inventory changed'):
            m.restored_candidate(root, root / 'ready.address', before)
        known.symlink_to(root / 'state/preserved.txt')
        with self.assertRaisesRegex(ValueError, 'non-regular journal'):
            m.session_inventory(root)

    def test_ephemeral_chain_has_explicit_key_identifiers_for_strict_tls(self):
        root = self.root()
        m.generate_tls(root)
        for name in ('ca.pem', 'server.pem'):
            with self.subTest(certificate=name):
                certificate = m.run(['openssl', 'x509', '-in', root / name, '-noout', '-text']).stdout
                self.assertIn(b'X509v3 Subject Key Identifier', certificate)
                self.assertIn(b'X509v3 Authority Key Identifier', certificate)
        # Actual chain verification, not just a config-text assertion. The
        # network test below additionally enables strict mode across Python
        # versions, including releases where it is not enabled by default.
        m.run(['openssl', 'verify', '-x509_strict', '-purpose', 'sslserver',
               '-CAfile', root / 'ca.pem', root / 'server.pem'])
        self.assertEqual(stat.S_IMODE((root / 'tls.key').stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((root / 'server.key').stat().st_mode), 0o600)

    def test_tls_server_real_https_503_and_tampered_stream(self):
        root = self.root()
        m.generate_tls(root)
        (root / 'mode').write_text('normal')
        asset = root / 'candidate'
        asset.write_bytes(b'signed-bytes')
        config = {'port': 0, 'target_version': '0.2.6', 'platform': 'linux-x86_64-appimage',
                  'endpoint': 'https://localhost:1/latest.json'}
        server = m.fixture_server(root, asset, 'signature', config)
        url = 'https://localhost:' + str(server.server_port)
        context = ssl.create_default_context(cafile=str(root / 'ca.pem'))
        context.verify_flags |= ssl.VERIFY_X509_STRICT
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
        try:
            with opener.open(url + '/latest.json', timeout=3) as response:
                manifest = json.load(response)
                self.assertEqual(manifest['version'], '0.2.6')
                self.assertNotIn('macos_distribution', manifest)
            config['macos_preview'] = True
            with opener.open(url + '/latest.json', timeout=3) as response:
                manifest = json.load(response)
                self.assertEqual(manifest['macos_distribution'], 'ad-hoc-unnotarized-preview')
                self.assertIn('not notarized', manifest['notes'])
            (root / 'mode').write_text('unavailable')
            with self.assertRaises(urllib.error.HTTPError) as error:
                opener.open(url + '/latest.json', timeout=3)
            self.assertEqual(error.exception.code, 503)
            error.exception.close()
            (root / 'mode').write_text('tampered')
            with opener.open(url + '/candidate', timeout=3) as response:
                data = response.read()
            self.assertEqual(len(data), len(asset.read_bytes()))
            self.assertNotEqual(data, asset.read_bytes())
            (root / 'mode').write_text('normal')
            with opener.open(url + '/candidate', timeout=3) as response:
                self.assertEqual(response.read(), asset.read_bytes())
        finally:
            server.shutdown()
            server.server_close()

    def test_failed_native_subprocess_cleans_server_and_never_creates_pass(self):
        args, receipt = self.receipt()
        root = self.root()
        args.root = str(root)
        args.base = str(self.directory / 'base.AppImage')
        pathlib.Path(args.base).write_bytes(b'disposable-base')
        args.timeout = 2
        args.rehearsal = False
        (root / 'updater.pub').write_text(pathlib.Path(args.public_key).read_text())
        m.write_json(root / 'rehearsal.json', {'platform': args.platform, 'target_version': receipt['version'],
                                             'base_version': '0.0.901'})
        server = unittest.mock.Mock()
        with patch.dict(os.environ, {'GITHUB_RUN_ID': '321', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': receipt['sha']}), \
                patch.object(m, 'current_checkout_sha', return_value=receipt['sha']), \
                patch.object(m, 'native_runner'), patch.object(m, 'fixture_server', return_value=server), \
                patch.object(m, 'launch_command', return_value=[sys.executable, '-c', 'raise SystemExit(7)']):
            with self.assertRaisesRegex(ValueError, 'exited before confirmed'):
                m.candidate_update(args)
        server.shutdown.assert_called_once()
        server.server_close.assert_called_once()
        self.assertTrue((root / 'FAIL.json').is_file())
        self.assertFalse((root / 'acceptance.json').exists())
        self.assertEqual(m.read_json(root / 'evidence.json')['status'], 'diagnostic-only')

    def test_failed_update_exports_hash_and_safe_lifecycle_not_tokens(self):
        root = self.root()
        m.create_data(root)
        (root / 'installed.AppImage').write_bytes(b'candidate bytes')
        trace = root / 'trace/candidate'
        trace.mkdir()
        records = [
            {'layer': 'host', 'event': 'start', 'payload': {'stateDir': str(root / 'state'),
                'readyFile': str(root / 'cache/ready-new.address'), 'workspace': str(root / 'workspace'),
                'desktopMode': True, 'token': 'DO-NOT-EXPORT'}},
            {'layer': 'host', 'event': 'restore', 'payload': {'restoredSessions': 1, 'issues': []}},
            {'layer': 'provider', 'event': 'credential', 'payload': {'apiKey': 'DO-NOT-EXPORT'}},
        ]
        (trace / 'events.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in records))
        result = m.update_diagnostics(root, None, {'platform': 'linux-x86_64-appimage'},
                                      {'package_sha256': m.digest(root / 'installed.AppImage')})
        self.assertFalse(result['nativeUpdateAccepted'])
        self.assertEqual(result['status'], 'diagnostic-only')
        self.assertTrue(result['exactCandidateInstalled'])
        self.assertEqual(len(result['hostLifecycle'][0]['events']), 2)
        self.assertNotIn('DO-NOT-EXPORT', json.dumps(result))
        self.assertNotIn(str(root), json.dumps(result))
        self.assertEqual(result['hostLifecycle'][0]['events'][1]['payload']['issueCount'], 0)
        self.assertIsNone(result['healthyReady'])
        self.assertIsNone(result['launcherExitCode'])

    def test_macos_failure_diagnostics_compare_installed_bundle_tree(self):
        root = self.root()
        m.create_data(root)
        for directory in ('installed', 'expected-candidate'):
            binary = root / directory / 'XHarness.app/Contents/MacOS/xharness-desktop'
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'exact candidate')
            binary.chmod(0o755)
        result = m.update_diagnostics(root, None, {'platform': 'darwin-x86_64'}, {'package_sha256': 'a' * 64})
        self.assertTrue(result['exactCandidateInstalled'])
        self.assertEqual(result['installed_bundle_tree_sha256'], result['expected_bundle_tree_sha256'])
        binary.write_bytes(b'modified')
        result = m.update_diagnostics(root, None, {'platform': 'darwin-x86_64'}, {'package_sha256': 'a' * 64})
        self.assertFalse(result['exactCandidateInstalled'])
        self.assertNotIn(str(root), json.dumps(result))

    def test_prepare_changes_only_disposable_source_and_needs_no_private_key(self):
        source = self.directory / 'original'
        files = ['apps/desktop/src-tauri/src/lib.rs', 'apps/desktop/src-tauri/src/sidecar.rs',
                 'apps/desktop/src-tauri/src/updater.rs', 'apps/desktop/src-tauri/Cargo.toml',
                 'apps/desktop/src-tauri/Cargo.lock', 'apps/desktop/src-tauri/tauri.conf.json',
                 'scripts/prepare-desktop-test-version.py', 'ui/dist/desktop-updater.js']
        for name in files:
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(m.REPO / name, target)
        (source / '.env').write_text('NEVER_COPY=secret')
        (source / 'signer.key').write_text('NEVER_COPY_PRIVATE_KEY')
        (source / 'ui/dist').mkdir(parents=True, exist_ok=True)
        (source / 'ui/dist/index.html').write_text('<html>fixture</html>')
        hashes = {name: m.digest(source / name) for name in files}
        _, _, pub = self.key_material()
        root = self.directory / 'prepared'
        args = argparse.Namespace(root=str(root), source=str(source), platform='darwin-aarch64',
                                  base_version='0.0.901', target_version='0.2.6', public_key=str(pub))
        with contextlib.redirect_stdout(io.StringIO()):
            m.prepare(args)
        self.assertEqual(hashes, {name: m.digest(source / name) for name in files})
        self.assertFalse((root / 'source/.env').exists())
        self.assertFalse((root / 'source/signer.key').exists())
        self.assertTrue((root / 'source/ui/dist/index.html').exists())
        base_ui = (root / 'source/ui/dist/desktop-updater.js').read_text()
        self.assertNotIn('initialTimer = window.setTimeout', base_ui)
        self.assertNotIn('periodicTimer = window.setInterval', base_ui)
        self.assertIn("await listen('xharness-update'", base_ui)
        desktop = root / 'source/apps/desktop/src-tauri'
        config = m.read_json(desktop / 'tauri.conf.json')
        self.assertFalse(config['bundle']['createUpdaterArtifacts'])
        self.assertEqual(config['version'], '0.0.901')
        updater = (desktop / 'src/updater.rs').read_text()
        self.assertIn('configure_client(crate::rehearsal::tls_client)', updater)
        self.assertEqual(updater.count('crate::rehearsal::snapshot_before_install();'), 1)
        self.assertLess(updater.index('sidecar::graceful_stop(&app).await'), updater.index('crate::rehearsal::snapshot_before_install();'))
        self.assertLess(updater.index('crate::rehearsal::snapshot_before_install();'), updater.index('update.install(bytes.as_slice())'))
        self.assertIn('tls_certs_merge', (desktop / 'src/rehearsal.rs').read_text())
        self.assertIn('ISOLATED_UNIX_UPDATE_ONLY', (desktop / 'src/rehearsal.rs').read_text())
        self.assertEqual(m.read_json(root / 'build-env.json')['XHARNESS_UPDATER_PUBKEY'], pub.read_text())
        self.assertEqual(m.read_json(root / 'rehearsal.json')['target_version'], '0.2.6')

    def test_base_timer_isolation_rejects_missing_duplicate_or_changed_anchors(self):
        source = (m.REPO / 'ui/dist/desktop-updater.js').read_text()
        anchor = '    initialTimer = window.setTimeout(() => controller.check(), 1500)'
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / 'updater.js'
            with self.assertRaisesRegex(ValueError, 'Missing regular'):
                m.isolate_base_updater_timers(path)
            for text in [source.replace(anchor, ''), source + '\n' + anchor,
                         source.replace('6 * 60 * 60 * 1000', '12345')]:
                path.write_text(text)
                with self.assertRaisesRegex(ValueError, 'anchor drifted'):
                    m.isolate_base_updater_timers(path)
                self.assertEqual(path.read_text(), text)

    def test_macos_owns_group_without_cross_session_or_preexec_callback(self):
        self.assertEqual(m.process_ownership('linux-x86_64-appimage'), {'start_new_session': True})
        with patch.object(m.sys, 'version_info', (3, 12, 0)):
            self.assertEqual(m.process_ownership('darwin-aarch64'), {'process_group': 0})
            self.assertEqual(m.process_ownership('darwin-x86_64'), {'process_group': 0})
        with patch.object(m.sys, 'version_info', (3, 9, 0)):
            with self.assertRaisesRegex(ValueError, 'Python 3.11'):
                m.process_ownership('darwin-aarch64')

    def test_timeout_terminates_owned_process_group(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            m.run([sys.executable, '-c', 'import time;time.sleep(90)'], timeout=.05)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.process = unittest.mock.Mock(pid=987654321)
        self.live = [{'pid': 987654322, 'pgid': self.process.pid, 'uid': 1000, 'stat': 'S'}]
        self.zombie = [{**self.live[0], 'stat': 'Z+'}]
        for target, name, value in ((m.os, 'getpgrp', lambda: 42), (m.os, 'getuid', lambda: 1000),
                                    (m.signal, 'SIGKILL', 9)):
            p = patch.object(target, name, value, create=True)
            p.start()
            self.addCleanup(p.stop)

    def stop(self, snapshots, errors=None):
        # Advance fake time without slowing down permission/timeout regressions.
        with patch.object(m, 'process_group_members', side_effect=snapshots), \
                patch.object(m.os, 'killpg', side_effect=errors, create=True) as killpg, \
                patch.object(m.time, 'sleep'), \
                patch.object(m.time, 'monotonic', side_effect=range(100)):
            m.stop_process(self.process)
        return killpg

    def test_absent_group_is_already_stopped(self):
        self.stop([[]]).assert_not_called()
        self.process.poll.assert_called()
        self.process.wait.assert_called_once_with(timeout=5)

    def test_zombie_only_group_is_reaped_without_signalling(self):
        self.stop([self.zombie]).assert_not_called()
        self.process.wait.assert_called_once_with(timeout=5)

    def test_term_completion_does_not_send_kill_to_zombies(self):
        killpg = self.stop([self.live, self.zombie])
        killpg.assert_called_once_with(self.process.pid, m.signal.SIGTERM)

    def test_restarted_descendant_is_killed_after_original_parent_exits(self):
        self.process.poll.return_value = 0
        killpg = self.stop([self.live, self.live, self.live, []])
        self.assertEqual(killpg.call_args_list, [unittest.mock.call(self.process.pid, m.signal.SIGTERM),
                                               unittest.mock.call(self.process.pid, m.signal.SIGKILL)])

    def test_permission_error_after_exit_requires_no_live_members(self):
        self.stop([self.live, self.zombie], PermissionError('race')).assert_called_once()

    def test_live_permission_error_is_not_suppressed(self):
        with self.assertRaises(PermissionError):
            self.stop([self.live, self.live], PermissionError('denied'))

    def test_process_lookup_race_is_not_success_if_members_remain(self):
        with self.assertRaises(ProcessLookupError):
            self.stop([self.live, self.live], ProcessLookupError('race'))

    def test_kill_must_actually_stop_descendants(self):
        with self.assertRaisesRegex(TimeoutError, 'still has live'):
            self.stop([self.live] * 20)

    def test_foreign_uid_and_own_group_are_never_signalled(self):
        with self.assertRaisesRegex(ValueError, 'ownership'):
            self.stop([[{**self.live[0], 'uid': 2000}]])
        self.process.pid = 42
        with self.assertRaisesRegex(ValueError, 'own process group'):
            self.stop([self.live])

    def test_transient_foreign_helper_after_term_only_waits_for_exit(self):
        foreign = [{**self.live[0], 'uid': 0, 'stat': 'R'}]
        killpg = self.stop([self.live, self.zombie + foreign, self.live, self.zombie])
        killpg.assert_called_once_with(self.process.pid, m.signal.SIGTERM)
        self.process.wait.assert_called_once_with(timeout=5)

    def test_foreign_helper_wait_never_signals_even_if_uid_becomes_owned_again(self):
        foreign = [{**self.live[0], 'uid': 0}]
        for remaining in (foreign, self.live):
            with self.subTest(remaining=remaining), \
                    patch.object(m, 'process_group_members', side_effect=[self.live, foreign] + [remaining] * 20), \
                    patch.object(m.os, 'killpg', create=True) as killpg, \
                    patch.object(m.time, 'sleep'), \
                    patch.object(m.time, 'monotonic', side_effect=range(100)):
                with self.assertRaisesRegex(ValueError, 'did not settle'):
                    m.stop_process(self.process)
                killpg.assert_called_once_with(self.process.pid, m.signal.SIGTERM)

    def test_foreign_helper_wait_inventory_failure_is_not_ignored(self):
        foreign = [{**self.live[0], 'uid': 0}]
        with patch.object(m, 'process_group_members', side_effect=[self.live, foreign, ValueError('inventory')]), \
                patch.object(m.os, 'killpg', create=True) as killpg, patch.object(m.time, 'sleep'):
            with self.assertRaisesRegex(ValueError, 'inventory'):
                m.stop_process(self.process)
            killpg.assert_called_once_with(self.process.pid, m.signal.SIGTERM)

    def test_passive_foreign_exit_preserves_numeric_cleanup_evidence(self):
        foreign = [{**self.live[0], 'uid': 0}]
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(m, 'process_group_members', side_effect=[self.live, foreign, []]), \
                patch.object(m.os, 'killpg', create=True), patch.object(m.time, 'sleep'):
            m.stop_process(self.process, pathlib.Path(temp))
            evidence = m.read_json(pathlib.Path(temp) / 'cleanup.json')
            self.assertEqual(evidence['status'], 'passed')
            self.assertTrue(evidence['passiveOwnershipWait'])
            self.assertEqual(evidence['signals'], [m.signal.SIGTERM])
            self.assertEqual(evidence['snapshots'], [self.live, foreign, []])

    def test_ps_parser_selects_only_exact_group(self):
        output = b' 101 20 1000 S\n 102 21 1000 Z+\n 103 20 1000 R\n'
        with patch.object(m, 'run', return_value=unittest.mock.Mock(stdout=output)) as run:
            self.assertEqual([p['pid'] for p in m.process_group_members(20)], [101, 103])
        self.assertEqual(run.call_args.args[0], ['ps', '-axo', 'pid=,pgid=,uid=,stat='])

    def test_unreadable_or_malformed_process_inventory_fails_closed(self):
        for output in (b'', b'garbage\n', b'1 2 nope S\n', b'1 2 1000 @\n'):
            with self.subTest(output=output), \
                    patch.object(m, 'run', return_value=unittest.mock.Mock(stdout=output)):
                with self.assertRaises(ValueError):
                    m.process_group_members(20)
        with patch.object(m, 'run', side_effect=subprocess.TimeoutExpired('ps', 10)):
            with self.assertRaises(subprocess.TimeoutExpired):
                m.process_group_members(20)

    def test_darwin_unknown_and_halted_states_are_parsed_but_not_considered_exited(self):
        for state in ('?', '?E', 'H'):
            with self.subTest(state=state), patch.object(m, 'run', return_value=unittest.mock.Mock(
                    stdout=f'987654322 {self.process.pid} 1000 {state}\n'.encode())):
                members = m.process_group_members(self.process.pid)
                self.assertEqual(members[0]['stat'], state)
                with self.assertRaises(PermissionError):
                    self.stop([members, members], PermissionError('denied'))

    def test_cleanup_evidence_records_failure_without_command_or_environment(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(m, 'process_group_members', return_value=self.live), \
                patch.object(m.os, 'killpg', side_effect=PermissionError('denied'), create=True):
            with self.assertRaises(PermissionError):
                m.stop_process(self.process, pathlib.Path(temp))
            evidence = m.read_json(pathlib.Path(temp) / 'cleanup.json')
            self.assertEqual(evidence['status'], 'failed')
            self.assertEqual(evidence['errorType'], 'PermissionError')
            self.assertEqual(evidence['snapshots'][-1], self.live)
            self.assertEqual(set(evidence['snapshots'][0][0]), {'pid', 'pgid', 'uid', 'stat'})

    def test_cleanup_success_requires_direct_child_reaped(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(m, 'process_group_members', return_value=[]):
            self.process.wait.side_effect = subprocess.TimeoutExpired('child', 5)
            with self.assertRaises(subprocess.TimeoutExpired):
                m.stop_process(self.process, pathlib.Path(temp))
            self.assertEqual(m.read_json(pathlib.Path(temp) / 'cleanup.json')['status'], 'failed')
            self.process.wait.side_effect = None
            m.stop_process(self.process, pathlib.Path(temp))
            self.assertEqual(m.read_json(pathlib.Path(temp) / 'cleanup.json')['status'], 'passed')


@unittest.skipUnless(os.name == 'posix', 'Requires real Unix process groups')
class NativeCleanupTests(unittest.TestCase):
    def test_real_exited_child_is_reaped(self):
        process = subprocess.Popen([sys.executable, '-c', 'pass'], process_group=0)
        try:
            time_limit = m.time.monotonic() + 5
            while m.time.monotonic() < time_limit:
                members = m.process_group_members(process.pid)
                if members and all(p['stat'].startswith('Z') for p in members):
                    break
                m.time.sleep(.05)
            m.stop_process(process)
            self.assertIsNotNone(process.returncode)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)

    def test_real_restarted_term_resistant_descendant_is_stopped(self):
        child_code = 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("ready",flush=True); time.sleep(60)'
        parent_code = 'import subprocess,sys; subprocess.Popen([sys.executable,"-c",sys.argv[1]])'
        outsider = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'], process_group=0)
        process = subprocess.Popen([sys.executable, '-c', parent_code, child_code],
                                   process_group=0, stdout=subprocess.PIPE, text=True)
        try:
            import select
            self.assertTrue(select.select([process.stdout], [], [], 10)[0], 'Descendant readiness timed out')
            self.assertEqual(process.stdout.readline().strip(), 'ready')
            process.wait(timeout=5)
            m.stop_process(process)
            self.assertFalse([p for p in m.process_group_members(process.pid) if not p['stat'].startswith('Z')])
            self.assertIsNone(outsider.poll(), 'Cleanup touched unrelated group')
        finally:
            m.stop_process(process)
            process.stdout.close()
            outsider.kill()
            outsider.wait(timeout=5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
