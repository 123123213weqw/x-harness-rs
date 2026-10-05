#!/usr/bin/env python3
"""Offline credentials/policy tests; --native uses disposable keys and C fixtures.

Never touches an installed app or compiles Rust. Native fixture signing is not
Gatekeeper/TCC or release acceptance evidence.
"""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import secrets
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('stable', ROOT / 'scripts/macos-stable-signing.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
DER = b'disposable-public-der'
PIN = hashlib.sha1(DER).hexdigest()


class StableSigning(unittest.TestCase):
    def app(self, root):
        app = Path(root) / 'XHarness.app'
        for relative in m.policy.COMPONENT_IDENTIFIERS:
            if relative != '.':
                path = app / relative; path.parent.mkdir(parents=True, exist_ok=True); path.touch()
        return app

    def native(self, args, **kwargs):
        args = [str(a) for a in args]
        result = b'Authority=XHarness Preview Signing\n'
        if '-r-' in args:
            target = Path(args[-1]).as_posix()
            relative = next((r for r in m.policy.COMPONENT_IDENTIFIERS if r != '.' and target.endswith(r)), '.')
            result = ('designated => ' + m.policy.requirement(m.policy.COMPONENT_IDENTIFIERS[relative], PIN) + '\n').encode()
        for arg in args:
            if arg.startswith('--extract-certificates='):
                Path(arg.split('=', 1)[1] + '0').write_bytes(DER)
        return subprocess.CompletedProcess(args, 0, b'', result)

    def test_all_components_verify_pin_and_designated_requirement_without_apple_claims(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(m.policy.subprocess, 'run', side_effect=self.native) as run:
            checks = m.policy.verify(self.app(folder), fingerprint=PIN)
        self.assertEqual(checks, {'codesignVerified': True, 'fixedCertificateVerified': True, 'designatedRequirementVerified': True})
        commands = [c.args[0] for c in run.call_args_list]
        extracts = [c for c in commands if any(a.startswith('--extract-certificates=') for a in c)]
        self.assertEqual(len(extracts), 4)
        for command in extracts:
            self.assertEqual(len(command), 4)
            self.assertNotIn('--extract-certificates', command)
        self.assertFalse(any(c[0] in ['spctl', 'xcrun'] for c in commands))

    def test_invalid_pin_policy_mix_missing_components_and_symlinks_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            app = self.app(folder)
            for pin in ['', 'a'*39, 'a'*41, 'A'*40, '../bad', None]:
                if pin is None: continue
                with self.subTest(pin=pin), self.assertRaises(ValueError): m.policy.verify(app, fingerprint=pin)
            with self.assertRaises(ValueError): m.policy.verify(app, preview=True, fingerprint=PIN)
            with self.assertRaises(ValueError): m.policy.verify(app, team='ABCDEFGHIJ', fingerprint=PIN)
            child = app / 'Contents/MacOS/rg'; child.unlink()
            with patch.object(m.policy.subprocess, 'run', side_effect=self.native), self.assertRaises(ValueError):
                m.policy.verify(app, fingerprint=PIN)
            other = Path(folder) / 'foreign'; other.touch(); child.symlink_to(other)
            with patch.object(m.policy.subprocess, 'run', side_effect=self.native), self.assertRaises(ValueError):
                m.policy.verify(app, fingerprint=PIN)

    def test_changed_certificate_or_requirement_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            app = self.app(folder)
            with patch.object(m.policy.subprocess, 'run', side_effect=self.native), self.assertRaises(ValueError):
                m.policy.verify(app, fingerprint='0'*40)
            def wrong(args, **kwargs):
                result = self.native(args, **kwargs)
                if '-r-' in args: result.stderr = b'designated => identifier "com.xlang.xharness"\n'
                return result
            with patch.object(m.policy.subprocess, 'run', side_effect=wrong), self.assertRaises(ValueError):
                m.policy.verify(app, fingerprint=PIN)

    def test_every_sign_uses_explicit_keychain_pin_identifier_and_requirement(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(m, 'command') as command, patch.object(m.policy, 'verify'):
            m.sign_app(self.app(folder), PIN, '/fixture/keychain')
        self.assertEqual(command.call_count, 4)
        for call, identifier in zip(command.call_args_list, m.policy.COMPONENT_IDENTIFIERS.values()):
            args = call.args[0]
            self.assertEqual(args[args.index('--sign')+1], PIN.upper())
            self.assertEqual(args[args.index('--identifier')+1], identifier)
            self.assertEqual(args[args.index('--keychain')+1], '/fixture/keychain')
            self.assertIn(m.policy.requirement(identifier, PIN), args[args.index('--requirements')+1])

    def test_continuity_verifies_both_versions_and_every_new_component(self):
        with patch.object(m.policy, 'verify') as verify, patch.object(m.policy.subprocess, 'run') as run:
            self.assertEqual(m.policy.verify_continuity('old.app', 'new.app', PIN), {'signingIdentityContinuityVerified': True})
            self.assertEqual(verify.call_count, 2); self.assertEqual(run.call_count, 4)
        with patch.object(m.policy, 'verify', side_effect=ValueError('wrong old identity')), patch.object(m.policy.subprocess, 'run') as run:
            with self.assertRaises(ValueError): m.policy.verify_continuity('old.app', 'new.app', PIN)
            run.assert_not_called()

    def test_private_import_is_never_allowed_on_pr_or_local_machine(self):
        env = dict(GITHUB_ACTIONS='true', RUNNER_ENVIRONMENT='github-hosted', GITHUB_EVENT_NAME='pull_request', GITHUB_REF='refs/pull/1/merge')
        with patch.dict(os.environ, env), patch.object(m.sys, 'platform', 'darwin'), patch.object(m, 'command') as run:
            with self.assertRaises(ValueError): m.import_identity()
            run.assert_not_called()
        with patch.dict(os.environ, {'GITHUB_ACTIONS':'false'}), patch.object(m.sys, 'platform', 'darwin'):
            with self.assertRaises(ValueError): m.import_identity()

    def test_macos_keychain_paths_do_not_depend_on_the_test_runner_os(self):
        for value, expected in [
            ('/Users/runner/Library/Keychains/login.keychain-db', True),
            ('/Users/runner/Library/Keychains/login with spaces.keychain-db', True),
            ('/Library/Keychains/System.keychain', True),
            ('relative.keychain-db', False),
            ('C:/Windows/publisher.keychain-db', False),
            ('C:\\Windows\\publisher.keychain-db', False),
            ('\\\\server\\share\\publisher.keychain-db', False),
            ('', False), (None, False), (12, False),
        ]:
            with self.subTest(value=value):
                self.assertEqual(m.macos_keychain_path(value), expected)

    def test_import_and_cleanup_use_only_runner_keychain_and_public_pin(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)/'github-env'; output.touch()
            env = {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','GITHUB_EVENT_NAME':'workflow_dispatch',
                   'GITHUB_REF':'refs/heads/master','RUNNER_TEMP':folder,'GITHUB_ENV':str(output),
                   'XHARNESS_MACOS_PREVIEW_CERT_SHA1':PIN,'XHARNESS_MACOS_PREVIEW_P12':base64.b64encode(b'fixture-p12').decode(),
                   'XHARNESS_MACOS_PREVIEW_P12_PASSWORD':'fixture-secret-password'}
            def fake(args, **kwargs):
                values=[str(a) for a in args]
                if 'create-keychain' in values: Path(values[-1]).touch()
                if values[:2] == ['openssl','pkcs12']:
                    Path(values[values.index('-out')+1]).write_text('public fixture certificate')
                if '-outform' in values: return DER
                if '-subject' in values: return b'subject=CN=fixture\nissuer=CN=fixture\n'
                if values == ['security','list-keychains','-d','user']:
                    return b'    \"/Users/runner/Library/Keychains/login.keychain-db\"\n'
                if 'find-identity' in values: return PIN.upper().encode()
                return b''
            with patch.dict(os.environ,env), patch.object(m.sys,'platform','darwin'), patch.object(m,'command',side_effect=fake) as run:
                m.import_identity()
                contents=output.read_text()
                self.assertNotIn('fixture-secret-password',contents)
                self.assertNotIn('fixture-p12',contents)
                keychain=Path(contents.strip().split('=',1)[1])
                self.assertFalse((keychain.parent/'publisher.p12').exists())
                self.assertEqual(json.loads((keychain.parent/'search-list.json').read_text()), ['/Users/runner/Library/Keychains/login.keychain-db'])
                m.cleanup_path(keychain)
                self.assertFalse(keychain.parent.exists())
                commands=[[str(a) for a in c.args[0]] for c in run.call_args_list]
                self.assertEqual(sum('list-keychains' in c for c in commands),3)
                self.assertFalse(any('default-keychain' in c or 'sudo' in c or 'add-trusted-cert' in c or 'trust-settings-import' in c for c in commands))

    def test_local_trust_and_forged_certificate_are_refused(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}), patch.object(m,'command') as run:
            with self.assertRaises(ValueError): m.validate_publisher_certificate('fixture.pem',PIN)
            run.assert_not_called()
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted'}), patch.object(m.sys,'platform','darwin'), \
                patch.object(m,'command',return_value=b'wrong-certificate') as run:
            with self.assertRaises(ValueError): m.validate_publisher_certificate('fixture.pem',PIN)
            self.assertFalse(any('add-trusted-cert' in c.args[0] for c in run.call_args_list))

    def test_cleanup_still_deletes_private_keychain_if_search_restore_fails(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'RUNNER_TEMP':folder,'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted'}), patch.object(m.sys,'platform','darwin'):
            work=Path(folder)/'xharness-publisher-signing-fixture';work.mkdir()
            keychain=work/'publisher.keychain-db';keychain.touch();(work/'search-list.json').write_text('[]')
            def fake(args,**kwargs):
                if 'list-keychains' in args: raise ValueError('injected native failure')
            with patch.object(m,'command',side_effect=fake) as run:
                with self.assertRaisesRegex(ValueError,'restore runner keychain search list'): m.cleanup_path(keychain)
                self.assertTrue(any('delete-keychain' in c.args[0] for c in run.call_args_list))
                self.assertTrue(work.exists())

    def test_search_list_receipt_precedes_mutation_and_preserves_original_paths(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'RUNNER_TEMP':folder,'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted'}), patch.object(m.sys,'platform','darwin'):
            work=Path(folder)/'xharness-publisher-signing-fixture';work.mkdir()
            keychain=work/'publisher.keychain-db';keychain.touch()
            previous=['/Users/runner/Library/Keychains/login with spaces.keychain-db']
            def fake(args,**kwargs):
                if '-s' not in args: return json.dumps(previous[0]).encode()
                self.assertEqual(json.loads((work/'search-list.json').read_text()),previous)
                raise ValueError('injected search list mutation timeout')
            with patch.object(m,'command',side_effect=fake), self.assertRaisesRegex(ValueError,'timeout'):
                m.attach_runner_keychain(keychain)
            with patch.object(m,'command') as run:
                m.cleanup_path(keychain)
                self.assertEqual(run.call_args_list[0].args[0],['security','list-keychains','-d','user','-s',*previous])

    def test_cleanup_reports_primary_and_secondary_failures(self):
        with patch.object(m,'cleanup_path',side_effect=ValueError('temporary trust restore failed')):
            with self.assertRaisesRegex(ValueError,'original signing stage.*cleanup also failed.*trust restore'):
                m.cleanup_after_failure('fixture',ValueError('original signing stage failed'))
        with patch.object(m,'cleanup_path') as cleanup:
            m.cleanup_after_failure('fixture',ValueError('original signing stage failed'))
            cleanup.assert_called_once_with('fixture')

    def test_native_fixture_reuses_production_trust_cleanup(self):
        source=Path(__file__).read_text().split('\ndef native_fixture():\n',1)[1]
        self.assertIn('m.cleanup_after_failure(keychain, original)',source)
        self.assertIn('m.cleanup_path(keychain)',source)
        self.assertNotIn('remove-trusted-cert',source)

    def test_native_failure_never_prints_secret_stderr_or_argv(self):
        with patch.object(m.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['secret-password'], stderr=b'private-key')):
            with self.assertRaises(ValueError) as error: m.command(['secret-password'])
        self.assertNotIn('secret-password', str(error.exception)); self.assertNotIn('private-key', str(error.exception))

    def test_cleanup_refuses_foreign_paths_without_touching_them(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'RUNNER_TEMP':folder}), patch.object(m, 'command') as run:
            for path in ['/Users/user/login.keychain-db', str(Path(folder)/'publisher.keychain-db'), str(Path(folder)/'wrong/publisher.keychain-db')]:
                with self.subTest(path=path), self.assertRaises(ValueError): m.cleanup_path(path)
            run.assert_not_called()

    @unittest.skipUnless(os.name == "posix", "Identity creation requires POSIX private-file permissions")
    def test_one_time_creation_never_overwrites_and_keeps_private_files_encrypted(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'XHARNESS_MACOS_PREVIEW_P12_PASSWORD': secrets.token_urlsafe(32)}):
            identity = Path(folder) / 'identity'
            with patch('sys.stdout', new=io.StringIO()): m.create_identity(identity)
            self.assertTrue((identity/'publisher.p12').is_file())
            self.assertEqual((identity/'publisher.p12').stat().st_mode & 0o777, 0o600)
            self.assertEqual(identity.stat().st_mode & 0o777, 0o700)
            self.assertFalse((identity/'private.pem').exists())
            with self.assertRaises(ValueError): m.create_identity(identity)


def native_fixture():
    if sys.platform != 'darwin' or os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise ValueError('Disposable native fixture requires hosted macOS CI; it never changes local trust')
    with tempfile.TemporaryDirectory(prefix='xharness-publisher-signing-native-', dir=os.environ['RUNNER_TEMP']) as folder:
        root = Path(folder); identity = root / 'identity'; keychain = root / 'publisher.keychain-db'
        password = secrets.token_urlsafe(32)
        env = {**os.environ, 'XHARNESS_MACOS_PREVIEW_P12_PASSWORD':password}
        with patch.dict(os.environ, env), patch('sys.stdout', new=io.StringIO()): m.create_identity(identity)
        pin = (identity / 'fingerprint.txt').read_text().strip()
        try:
            m.command(['security','create-keychain','-p',password,keychain])
            m.command(['security','unlock-keychain','-p',password,keychain])
            m.command(['security','import',identity/'publisher.p12','-k',keychain,'-P',password,'-T','/usr/bin/codesign'])
            m.command(['security','set-key-partition-list','-S','apple-tool:,apple:','-s','-k',password,keychain])
            certificate=root/'certificate.pem'; certificate.write_bytes((identity/'certificate.pem').read_bytes())
            m.validate_publisher_certificate(certificate, pin)
            m.attach_runner_keychain(keychain)
            source = root / 'fixture.c'; source.write_text('int main(void) { return 0; }\n')
            apps = []
            for version in ['1.0.0','1.0.1']:
                app = root / version / 'XHarness.app'; apps.append(app)
                main = app / 'Contents/MacOS'; main.mkdir(parents=True)
                for name in ['rg','xharness-host','xharness-desktop']:
                    m.command(['/usr/bin/clang',source,'-o',main/name])
                (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'com.xlang.xharness',
                    'CFBundleExecutable':'xharness-desktop','CFBundleShortVersionString':version,'CFBundlePackageType':'APPL'}))
                original = m.command
                def fixture_command(args, **kwargs):
                    if args[0] != 'codesign': return original(args, **kwargs)
                    result = subprocess.run([str(a) for a in args], capture_output=True, timeout=90)
                    if result.returncode:
                        raise ValueError('Disposable fixture codesign diagnostic: ' + result.stderr.decode(errors='replace'))
                    return result.stdout
                with patch.object(m, 'command', side_effect=fixture_command):
                    m.sign_app(app, pin, keychain)
            m.policy.verify_continuity(*apps, pin)
            print('PASS: native old/new fixed certificate and all component DR continuity (not TCC/Gatekeeper acceptance)')
        except Exception as original:
            m.cleanup_after_failure(keychain, original)
            raise
        else:
            m.cleanup_path(keychain)


if __name__ == '__main__':
    if '--native' in sys.argv:
        native_fixture()
    else:
        unittest.main()
