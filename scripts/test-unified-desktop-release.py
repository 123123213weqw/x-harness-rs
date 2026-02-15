#!/usr/bin/env python3
"""Public-material contract tests; ephemeral JS keys, no Rust compilation/network.

Synthetic files exercise metadata/cryptographic rejection only. They are not
installation evidence and cannot authorize a real release.
"""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('unified_release', ROOT / 'scripts/desktop-release.py')
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)
REPOSITORY = '123123213weqw/x-harness-rs'
SHA = 'a' * 40
CI = {'id': 101, 'run_attempt': 1, 'head_sha': SHA, 'head_branch': 'master',
      'event': 'push', 'status': 'completed', 'conclusion': 'success', 'path': '.github/workflows/ci.yml'}


def save(path, value):
    Path(path).write_text(json.dumps(value, sort_keys=True) + '\n', encoding='utf-8')


def plan(**overrides):
    args = {'repository': REPOSITORY, 'configured_repository': REPOSITORY, 'tag': 'desktop-v0.2.6',
            'sha': SHA, 'run_id': '1234', 'attempt': '1',
            'releases': [{'tagName': 'friends-v0.2.5', 'isDraft': False}], 'runs': [copy.deepcopy(CI)]}
    args.update(overrides)
    return contract.make_plan(**args)


class PlanTests(unittest.TestCase):
    def test_same_stable_endpoint_and_plain_incrementing_version(self):
        result = plan()
        self.assertEqual(result['version'], '0.2.6')
        self.assertEqual(result['endpoint'], 'https://github.com/' + REPOSITORY + '/releases/latest/download/latest.json')
        self.assertEqual(result['ci'], CI)

    def test_explicit_repository_opt_in_is_required(self):
        for configured in ['', 'other/repository', REPOSITORY + '\n']:
            with self.subTest(configured=configured), self.assertRaises(ValueError):
                plan(configured_repository=configured)
        for repository in ['../repo', 'owner/repo/extra', 'owner/repo?x=1']:
            with self.subTest(repository=repository), self.assertRaises(ValueError):
                plan(repository=repository, configured_repository=repository)

    def test_reject_invalid_tag_version_and_sha(self):
        for tag in ['friends-v0.2.6', 'desktop-v0.2.6\n', 'desktop-v01.2.6', 'desktop-v1.2',
                    'desktop-v65536.0.0', 'desktop-v0.2.6-rc.1', 'desktop-v1;touch pwn']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                plan(tag=tag)
        for sha in ['', 'a' * 39, 'A' * 40, SHA + '\n']:
            with self.subTest(sha=sha), self.assertRaises(ValueError):
                plan(sha=sha)

    def test_never_overwrite_draft_or_published_version(self):
        for draft in [False, True]:
            with self.subTest(draft=draft), self.assertRaises(ValueError):
                plan(releases=[{'tagName': 'desktop-v0.2.6', 'isDraft': draft}])
        with self.assertRaises(ValueError):
            plan(releases=[{'tagName': 'friends-v0.2.6', 'isDraft': True}])

    def test_never_regress_friends_or_desktop_stable_version(self):
        for prefix in ['friends-v', 'desktop-v']:
            for previous in ['0.2.6', '0.3.0', '1.0.0']:
                with self.subTest(prefix=prefix, previous=previous), self.assertRaises(ValueError):
                    plan(releases=[{'tagName': prefix + previous, 'isDraft': False}])

    def test_latest_exact_ci_must_pass_not_any_old_success(self):
        for field, bad in [('head_sha', 'b' * 40), ('event', 'pull_request'), ('head_branch', 'other'),
                           ('path', '.github/workflows/untrusted.yml'), ('status', 'in_progress'),
                           ('conclusion', 'failure'), ('conclusion', 'cancelled'), ('run_attempt', 0)]:
            run = copy.deepcopy(CI)
            run[field] = bad
            with self.subTest(field=field, bad=bad), self.assertRaises(ValueError):
                plan(runs=[run])
        for failure in [{'id': 102, 'conclusion': 'failure'}, {'id': 101, 'run_attempt': 2, 'status': 'queued'}]:
            latest = dict(CI, **failure)
            with self.subTest(latest=latest), self.assertRaises(ValueError):
                plan(runs=[copy.deepcopy(CI), latest])

    def test_latest_ci_with_unrelated_commit_does_not_replace_exact_ci(self):
        self.assertEqual(plan(runs=[dict(CI, id=102, head_sha='b' * 40), CI])['ci'], CI)

    def test_plan_rejects_ambiguous_and_unrecognized_metadata(self):
        for key, value in [('schema_version', True), ('release_run_id', '1\n'), ('release_run_attempt', '0'),
                           ('endpoint', 'http://evil/latest.json'), ('version', '0.2.7'), ('private_key', 'secret')]:
            result = plan()
            result[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                contract.validate_plan(result)


class PackageContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Keep disposable private keys only in this one Node process. Only test
        # public packets/signatures leave it; never consult a user secret store.
        script = r'''
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
function signer(id) {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const key = publicKey.export({format:'der', type:'spki'}).subarray(-32);
  const keyid = Buffer.alloc(8, id);
  const pubPacket = Buffer.concat([Buffer.from('Ed'), keyid, key]);
  const pub = Buffer.from('untrusted comment: disposable test public key\n' + pubPacket.toString('base64') + '\n').toString('base64');
  const packages = {};
  for (const platform of ['windows-x86_64','darwin-aarch64','darwin-x86_64','linux-x86_64-appimage','old']) {
    const bytes = Buffer.from('synthetic signed package for contract tests only: ' + platform);
    const signature = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey);
    const packet = Buffer.concat([Buffer.from('ED'), keyid, signature]);
    const comment = 'timestamp:0\tfile:test';
    const trusted = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    const sig = Buffer.from('untrusted comment: disposable test signature\n' + packet.toString('base64') + '\ntrusted comment: ' + comment + '\n' + trusted.toString('base64') + '\n').toString('base64');
    packages[platform] = {bytes:bytes.toString('base64'), sig};
  }
  return {pub, packages};
}
process.stdout.write(JSON.stringify({primary: signer(1), other: signer(2)}));
'''
        cls.fixtures = json.loads(subprocess.check_output(['node', '-e', script], text=True, encoding='utf-8'))

    def setUp(self):
        import base64
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = plan()
        self.pub = self.root / 'expected.pub'
        self.pub.write_text(self.fixtures['primary']['pub'] + '\n', encoding='utf-8')
        self.other_pub = self.root / 'other.pub'
        self.other_pub.write_text(self.fixtures['other']['pub'] + '\n', encoding='utf-8')
        self.config = self.root / 'tauri.conf.json'
        save(self.config, {'version': self.plan['version'], 'identifier': contract.IDENTIFIER,
                           'plugins': {'updater': {'pubkey': self.fixtures['primary']['pub']}}})
        self.artifacts = self.root / 'artifacts'
        self.artifacts.mkdir()
        self.binaries = {}
        self.packages = {}
        for platform, (target, _) in contract.PLATFORMS.items():
            source = self.root / ('source-' + platform)
            source.mkdir()
            package = source / 'package.bin'
            fixture = self.fixtures['primary']['packages'][platform]
            package.write_bytes(base64.b64decode(fixture['bytes']))
            Path(str(package) + '.sig').write_text(fixture['sig'] + '\n', encoding='utf-8')
            binary = source / 'desktop.bin'
            header = bytearray(128)
            if platform == 'windows-x86_64':
                header[:2] = b'MZ'
                struct.pack_into('<I', header, 60, 80)
                header[80:84] = b'PE\0\0'
                struct.pack_into('<H', header, 84, 0x8664)
            elif platform.startswith('darwin-'):
                header[:4] = b'\xcf\xfa\xed\xfe'
                struct.pack_into('<I', header, 4, 0x100000c if platform == 'darwin-aarch64' else 0x1000007)
            else:
                header[:6] = b'\x7fELF\x02\x01'
                struct.pack_into('<H', header, 18, 62)
            binary.write_bytes(header + self.plan['endpoint'].encode() + b'\0' + self.fixtures['primary']['pub'].encode())
            self.binaries[platform] = binary
            self.packages[platform] = package
            contract.create_receipt(self.plan, platform, target, package, self.pub, binary,
                                    self.config, self.artifacts / platform)
        self.output = self.root / 'release'

    def assemble(self):
        return contract.assemble(self.plan, self.artifacts, self.pub, self.output)

    def receipt_path(self, platform='windows-x86_64'):
        return self.artifacts / platform / 'receipt.json'

    def rewrite_receipt(self, **updates):
        path = self.receipt_path()
        value = contract.read_json(path)
        value.update(updates)
        save(path, value)

    def refresh_output_hashes(self):
        evidence = contract.read_json(self.output / 'release-evidence.json')
        evidence['manifest_sha256'] = contract.sha256(self.output / 'latest.json')
        evidence['receipts'] = {platform: contract.sha256(self.output / (platform + '.receipt.json')) for platform in contract.PLATFORMS}
        save(self.output / 'release-evidence.json', evidence)
        (self.output / 'SHA256SUMS').write_text(contract.checksums(self.output), encoding='ascii')

    def live(self, all_platforms=False):
        import base64
        root = self.root / 'live'
        root.mkdir()
        shutil.copyfile(self.pub, root / 'updater.pub')
        platforms = {}
        for platform in (contract.PLATFORMS if all_platforms else ['windows-x86_64']):
            name = contract.PLATFORMS[platform][1].format(version='0.2.5')
            fixture = self.fixtures['primary']['packages']['old' if platform == 'windows-x86_64' else platform]
            (root / name).write_bytes(base64.b64decode(fixture['bytes']))
            (root / (name + '.sig')).write_text(fixture['sig'] + '\n', encoding='utf-8')
            platforms[platform] = {'signature': fixture['sig'], 'url': f'https://github.com/{REPOSITORY}/releases/download/friends-v0.2.5/{name}'}
        save(root / 'latest.json', {'version': '0.2.5', 'platforms': platforms})
        return root

    def acceptances(self):
        root = self.root / 'acceptances'
        root.mkdir()
        for platform in contract.PLATFORMS:
            windows = platform == 'windows-x86_64'
            directory = root / platform
            directory.mkdir()
            value = {key: self.plan[key] for key in ['version', 'sha', 'release_run_id', 'release_run_attempt']}
            value.update(schema_version=1, platform=platform, status='passed', nativeUpdateAccepted=True,
                         manifest_sha256=contract.sha256(self.output / 'latest.json'),
                         package_sha256=contract.sha256(self.output / contract.package_name(self.plan, platform)),
                         scope='exact-production-candidate' if windows else 'instrumented-base-to-signed-candidate',
                         baseInstrumented=not windows, base_version='0.2.5',
                         checks={key: True for key in contract.PLATFORM_CHECKS[platform]},
                         provenance={'workflow': '.github/workflows/desktop-' + ('windows' if windows else 'unix') + '-update-acceptance.yml',
                                     'run_id': '4321' if windows else '4322', 'run_attempt': '1', 'source_sha': SHA})
            save(directory / 'acceptance.json', value)
        return root

    def test_complete_receipts_aggregate_once_and_verify_independently(self):
        evidence = self.assemble()
        manifest, validated = contract.validate_release(self.plan, self.output, self.pub)
        self.assertEqual(evidence, validated)
        self.assertEqual(set(manifest['platforms']), set(contract.PLATFORMS))
        self.assertNotIn('linux-x86_64', manifest['platforms'], 'Fallback would send AppImage to deb/rpm clients')
        self.assertEqual({path.name for path in self.output.iterdir()}, contract.release_names(self.plan))
        self.assertEqual(manifest['version'], '0.2.6')
        self.assertEqual(evidence['status'], 'candidate-verified-not-native-accepted')
        for platform, entry in manifest['platforms'].items():
            self.assertIn('/desktop-v0.2.6/', entry['url'])
            self.assertTrue(entry['url'].endswith(contract.package_name(self.plan, platform)))
        with self.assertRaisesRegex(ValueError, 'never overwrite'):
            self.assemble()

    def test_no_overwrite_receipt_directory(self):
        platform = 'windows-x86_64'
        with self.assertRaisesRegex(ValueError, 'never overwrite'):
            contract.create_receipt(self.plan, platform, contract.PLATFORMS[platform][0], self.packages[platform],
                                    self.pub, self.binaries[platform], self.config, self.artifacts / platform)

    def test_reject_incomplete_or_duplicate_platform_set(self):
        path = self.artifacts / 'darwin-x86_64'
        moved = self.root / 'moved'
        path.rename(moved)
        with self.assertRaisesRegex(ValueError, 'four platform'):
            self.assemble()
        moved.rename(path)
        shutil.copytree(path, self.artifacts / 'darwin-x86_64-copy')
        with self.assertRaisesRegex(ValueError, 'four platform'):
            self.assemble()

    def test_reject_platform_directory_and_package_symlinks(self):
        path = self.artifacts / 'darwin-x86_64'
        moved = self.root / 'moved'
        path.rename(moved)
        path.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            self.assemble()
        path.unlink()
        moved.rename(path)
        name = contract.package_name(self.plan, 'darwin-x86_64')
        (path / name).unlink()
        (path / name).symlink_to(self.packages['darwin-x86_64'])
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            self.assemble()

    def test_secret_and_other_extra_files_or_subdirectories_are_rejected(self):
        for extra in ['.env', '.env.production', 'private.key', 'latest.json', 'another.sig', 'README.md']:
            path = self.artifacts / 'windows-x86_64' / extra
            path.write_text('must not escape an artifact', encoding='utf-8')
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.assemble()
            path.unlink()
        (self.artifacts / 'windows-x86_64' / 'nested').mkdir()
        with self.assertRaises(ValueError):
            self.assemble()

    def test_reject_missing_signature_package_and_key(self):
        platform = 'windows-x86_64'
        name = contract.package_name(self.plan, platform)
        for filename in [name, name + '.sig', 'updater.pub', 'receipt.json']:
            path = self.artifacts / platform / filename
            original = path.read_bytes()
            path.unlink()
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                self.assemble()
            path.write_bytes(original)

    def test_reject_receipt_metadata_drift_and_path_traversal(self):
        original = contract.read_json(self.receipt_path())
        cases = [('sha', 'b' * 40), ('version', '0.2.7'), ('tag', 'friends-v0.2.6'),
                 ('schema_version', True), ('ci', dict(CI, run_attempt=True)),
                 ('release_run_id', '1235'), ('release_run_attempt', '2'), ('ci', dict(CI, run_attempt=2)),
                 ('platform', 'darwin-x86_64'), ('target', 'aarch64-apple-darwin'),
                 ('package', '../outside.exe'), ('package', 'a\\b.exe'), ('package', '/tmp/outside.exe'),
                 ('embedded_endpoint', 'https://evil.invalid/latest.json'), ('identifier', 'other.application'),
                 ('binary_sha256', 'not-a-hash'), ('package_size', 0), ('package_size', True),
                 ('package_sha256', '0' * 64), ('public_key_sha256', '0' * 64), ('secret', 'private material')]
        for key, value in cases:
            save(self.receipt_path(), dict(original, **{key: value}))
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.assemble()
        save(self.receipt_path(), original)

    def test_tamper_rejected_even_after_attacker_updates_receipt_hash_and_size(self):
        package = self.artifacts / 'windows-x86_64' / contract.package_name(self.plan, 'windows-x86_64')
        package.write_bytes(package.read_bytes() + b'tampered')
        self.rewrite_receipt(package_sha256=contract.sha256(package), package_size=package.stat().st_size)
        with self.assertRaisesRegex(ValueError, 'signature verification failed'):
            self.assemble()

    def test_wrong_key_signature_and_swapped_platform_signature_rejected(self):
        platform = 'windows-x86_64'
        signature = self.artifacts / platform / (contract.package_name(self.plan, platform) + '.sig')
        for replacement in [self.fixtures['other']['packages'][platform]['sig'],
                            self.fixtures['primary']['packages']['darwin-x86_64']['sig'], '', 'not base64']:
            signature.write_text(replacement, encoding='utf-8')
            self.rewrite_receipt(signature=replacement)
            with self.subTest(replacement=replacement[:20]), self.assertRaises(ValueError):
                self.assemble()

    def test_correct_signature_but_wrong_receipt_signature_is_rejected(self):
        self.rewrite_receipt(signature=self.fixtures['primary']['packages']['darwin-aarch64']['sig'])
        with self.assertRaisesRegex(ValueError, 'Receipt signature mismatch'):
            self.assemble()

    def test_trust_key_rotation_rejected(self):
        shutil.copyfile(self.other_pub, self.artifacts / 'windows-x86_64' / 'updater.pub')
        with self.assertRaisesRegex(ValueError, 'trust key changed'):
            self.assemble()
        with self.assertRaises(ValueError):
            contract.assemble(self.plan, self.artifacts, self.other_pub, self.output)

    def test_strict_public_key_and_duplicate_json_keys(self):
        for invalid in ['', 'secret', 'c2VjcmV0', 'eA==\neA==']:
            self.other_pub.write_text(invalid, encoding='utf-8')
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                contract.public_key(self.other_pub)
        self.receipt_path().write_text('{"version":"0.2.6","version":"9.9.9"}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON'):
            self.assemble()

    def test_bundler_config_version_identifier_and_key_must_match(self):
        platform = 'windows-x86_64'
        original = contract.read_json(self.config)
        for config in [dict(original, version='0.2.5'), dict(original, identifier='com.other'),
                       dict(original, plugins={'updater': {'pubkey': 'other'}})]:
            save(self.config, config)
            with self.subTest(config=config), self.assertRaises(ValueError):
                contract.create_receipt(self.plan, platform, contract.PLATFORMS[platform][0], self.packages[platform],
                                        self.pub, self.binaries[platform], self.config, self.root / 'bad')

    def test_binary_architecture_and_embedded_channel_are_checked(self):
        for platform in contract.PLATFORMS:
            binary = self.binaries[platform]
            original = binary.read_bytes()
            mutations = [original.replace(self.plan['endpoint'].encode(), b'wrong'),
                         original.replace(self.fixtures['primary']['pub'].encode(), b'wrong'),
                         b'INVALID!' + original[8:]]
            for mutation in mutations:
                binary.write_bytes(mutation)
                with self.subTest(platform=platform, mutation=mutation[:8]), self.assertRaises(ValueError):
                    contract.binary_channel(binary, platform, self.plan, self.fixtures['primary']['pub'])
            binary.write_bytes(original)
        with self.assertRaisesRegex(ValueError, 'architecture'):
            contract.binary_channel(self.binaries['darwin-aarch64'], 'darwin-x86_64', self.plan, self.fixtures['primary']['pub'])

    def test_receipt_target_cannot_be_relabelled(self):
        platform = 'windows-x86_64'
        with self.assertRaisesRegex(ValueError, 'target mismatch'):
            contract.create_receipt(self.plan, platform, 'aarch64-apple-darwin', self.packages[platform],
                                    self.pub, self.binaries[platform], self.config, self.root / 'bad')

    def test_release_manifest_cannot_be_replaced_by_single_platform_output(self):
        self.assemble()
        manifest = contract.read_json(self.output / 'latest.json')
        manifest['platforms'] = {'windows-x86_64': manifest['platforms']['windows-x86_64']}
        save(self.output / 'latest.json', manifest)
        self.refresh_output_hashes()
        with self.assertRaisesRegex(ValueError, 'platform set'):
            contract.validate_release(self.plan, self.output, self.pub)

    def test_unsafe_linux_fallback_is_rejected_even_with_valid_checksums(self):
        self.assemble()
        manifest = contract.read_json(self.output / 'latest.json')
        manifest['platforms']['linux-x86_64'] = manifest['platforms']['linux-x86_64-appimage']
        save(self.output / 'latest.json', manifest)
        self.refresh_output_hashes()
        with self.assertRaisesRegex(ValueError, 'platform set'):
            contract.validate_release(self.plan, self.output, self.pub)

    def test_wrong_version_mutable_or_external_urls_are_rejected(self):
        self.assemble()
        original = contract.read_json(self.output / 'latest.json')
        name = contract.package_name(self.plan, 'windows-x86_64')
        for url in [f'https://github.com/{REPOSITORY}/releases/latest/download/{name}',
                    f'https://github.com/{REPOSITORY}/releases/download/desktop-v9.9.9/{name}',
                    'https://evil.invalid/' + name, 'file:///tmp/' + name]:
            manifest = copy.deepcopy(original)
            manifest['platforms']['windows-x86_64']['url'] = url
            save(self.output / 'latest.json', manifest)
            self.refresh_output_hashes()
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'package URL'):
                contract.validate_release(self.plan, self.output, self.pub)

    def test_release_inventory_checksum_and_receipt_evidence_must_match(self):
        self.assemble()
        checksum_path = self.output / 'SHA256SUMS'
        original = checksum_path.read_text(encoding='utf-8')
        checksum_path.write_text(original + '0' * 64 + '  unexpected\n')
        with self.assertRaisesRegex(ValueError, 'checksum inventory'):
            contract.validate_release(self.plan, self.output, self.pub)
        checksum_path.write_text(original)
        (self.output / '.env').write_text('private')
        with self.assertRaises(ValueError):
            contract.validate_release(self.plan, self.output, self.pub)
        (self.output / '.env').unlink()
        evidence = contract.read_json(self.output / 'release-evidence.json')
        evidence['receipts']['windows-x86_64'] = '0' * 64
        save(self.output / 'release-evidence.json', evidence)
        checksum_path.write_text(contract.checksums(self.output), encoding='ascii')
        with self.assertRaisesRegex(ValueError, 'Receipt evidence hash'):
            contract.validate_release(self.plan, self.output, self.pub)

    def test_promotion_requires_complete_real_bound_acceptance_and_unchanged_key(self):
        self.assemble()
        accepted = self.acceptances()
        live = self.live()
        result = contract.promotion(self.plan, self.output, accepted, live, self.pub, [CI])
        self.assertEqual(result['status'], 'promotion-authorized')
        self.assertEqual(result['previous_live_version'], '0.2.5')
        self.assertEqual(set(result['acceptance_sha256']), set(contract.PLATFORMS))

    def test_promotion_supports_previous_full_unified_manifest(self):
        self.assemble()
        manifest = contract.read_json(self.output / 'latest.json')
        live = self.live(all_platforms=True)
        self.assertEqual(set(contract.validate_live(self.plan, live, manifest, self.pub)['platforms']), set(contract.PLATFORMS))

    def test_promotion_rejects_ci_rerun_newer_failure_and_wrong_source(self):
        self.assemble()
        accepted = self.acceptances()
        live = self.live()
        for runs in [[dict(CI, run_attempt=2)], [CI, dict(CI, id=102, conclusion='failure')],
                     [dict(CI, head_sha='b' * 40)], [dict(CI, id=102)]]:
            with self.subTest(runs=runs), self.assertRaises(ValueError):
                contract.promotion(self.plan, self.output, accepted, live, self.pub, runs)

    def test_promotion_rejects_missing_platform_evidence(self):
        self.assemble()
        accepted = self.acceptances()
        shutil.rmtree(accepted / 'darwin-x86_64')
        with self.assertRaisesRegex(ValueError, 'all four'):
            contract.validate_acceptance(self.plan, accepted, self.output, contract.sha256(self.output / 'latest.json'))

    def test_acceptance_cannot_substitute_smoke_old_sha_or_other_manifest(self):
        self.assemble()
        accepted = self.acceptances()
        path = accepted / 'windows-x86_64' / 'acceptance.json'
        original = contract.read_json(path)
        for key, bad in [('status', 'smoke-passed'), ('nativeUpdateAccepted', False), ('nativeUpdateAccepted', 1),
                         ('sha', 'b' * 40), ('version', '0.2.5'), ('release_run_id', '1233'), ('release_run_attempt', '2'),
                         ('manifest_sha256', '0' * 64), ('package_sha256', '0' * 64), ('base_version', '0.2.6'),
                         ('baseInstrumented', True), ('scope', 'candidate-native'), ('extra', 'unverified')]:
            save(path, dict(original, **{key: bad}))
            with self.subTest(key=key), self.assertRaises(ValueError):
                contract.validate_acceptance(self.plan, accepted, self.output, contract.sha256(self.output / 'latest.json'))
        for provenance in [dict(original['provenance'], source_sha='b' * 40),
                           dict(original['provenance'], workflow='.github/workflows/other.yml'),
                           dict(original['provenance'], run_attempt='0')]:
            save(path, dict(original, provenance=provenance))
            with self.subTest(provenance=provenance), self.assertRaises(ValueError):
                contract.validate_acceptance(self.plan, accepted, self.output, contract.sha256(self.output / 'latest.json'))

    def test_every_native_check_including_apple_gates_is_mandatory(self):
        self.assemble()
        accepted = self.acceptances()
        manifest_hash = contract.sha256(self.output / 'latest.json')
        for platform in contract.PLATFORMS:
            path = accepted / platform / 'acceptance.json'
            original = contract.read_json(path)
            for check in contract.PLATFORM_CHECKS[platform]:
                value = copy.deepcopy(original)
                value['checks'][check] = False
                save(path, value)
                with self.subTest(platform=platform, check=check), self.assertRaisesRegex(ValueError, 'native checks'):
                    contract.validate_acceptance(self.plan, accepted, self.output, manifest_hash)
            value = copy.deepcopy(original)
            value['checks'][next(iter(value['checks']))] = 1
            save(path, value)
            with self.assertRaises(ValueError):
                contract.validate_acceptance(self.plan, accepted, self.output, manifest_hash)
            save(path, original)

    def test_live_key_change_manifest_signature_and_tampering_are_rejected(self):
        self.assemble()
        live = self.live()
        manifest = contract.read_json(self.output / 'latest.json')
        shutil.copyfile(self.other_pub, live / 'updater.pub')
        with self.assertRaisesRegex(ValueError, 'live updater trust key'):
            contract.validate_live(self.plan, live, manifest, self.pub)
        shutil.copyfile(self.pub, live / 'updater.pub')
        name = 'XHarness_0.2.5_x64-setup.exe'
        (live / name).write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'signature verification failed'):
            contract.validate_live(self.plan, live, manifest, self.pub)

    def test_live_version_and_platforms_can_never_regress(self):
        self.assemble()
        live = self.live()
        candidate = contract.read_json(self.output / 'latest.json')
        original = contract.read_json(live / 'latest.json')
        for old_version in ['0.2.6', '0.3.0', '1.0.0']:
            save(live / 'latest.json', dict(original, version=old_version))
            with self.subTest(version=old_version), self.assertRaisesRegex(ValueError, 'newer'):
                contract.validate_live(self.plan, live, candidate, self.pub)
        for platform in ['windows-aarch64', 'linux-x86_64', 'linux-x86_64-deb', 'linux-x86_64-rpm']:
            value = copy.deepcopy(original)
            value['platforms'][platform] = value['platforms']['windows-x86_64']
            save(live / 'latest.json', value)
            with self.subTest(platform=platform), self.assertRaisesRegex(ValueError, 'drop a live updater platform'):
                contract.validate_live(self.plan, live, candidate, self.pub)

    def test_live_urls_cannot_fetch_external_mutable_or_traversal_assets(self):
        self.assemble()
        live = self.live()
        candidate = contract.read_json(self.output / 'latest.json')
        original = contract.read_json(live / 'latest.json')
        for url in ['https://evil.invalid/X.exe', f'https://github.com/{REPOSITORY}/releases/latest/download/X.exe',
                    f'https://github.com/{REPOSITORY}/releases/download/friends-v0.2.5/..',
                    f'https://github.com/{REPOSITORY}/releases/download/friends-v0.2.5/%2e%2e',
                    f'https://github.com/{REPOSITORY}/releases/download/friends-v0.2.5/X.exe?key=secret']:
            value = copy.deepcopy(original)
            value['platforms']['windows-x86_64']['url'] = url
            save(live / 'latest.json', value)
            with self.subTest(url=url), self.assertRaises(ValueError):
                contract.validate_live(self.plan, live, candidate, self.pub)


if __name__ == '__main__':
    unittest.main()
