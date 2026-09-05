import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('friends', ROOT / 'scripts/friends-release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


REPOSITORY = '123123213weqw/x-harness-rs'


def plan(repository, tag, releases):
    return module.plan(repository, tag, releases, configured_repository=repository)


def manifest(repository, tag, root):
    return module.manifest(repository, tag, root, configured_repository=repository)


class ChannelTests(unittest.TestCase):
    def test_repository_requires_explicit_exact_opt_in(self):
        for repository in ['123123213weqw/x-harness-rs', 'yyqdbngt/x-harness-rs']:
            self.assertEqual(module.validate_repository(repository, repository), repository)
            for configured in ['', 'another/project', repository + '\n']:
                with self.subTest(repository=repository, configured=configured), self.assertRaises(ValueError):
                    module.validate_repository(repository, configured)
        for invalid in ['', 'owner', 'owner/repo/extra', '../repo', 'owner/repo?x=1', 'owner/repo\n']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                module.validate_repository(invalid, invalid)

    def test_workflow_keeps_signing_in_fork_tag_release(self):
        source = (ROOT / '.github/workflows/friends-release.yml').read_text(encoding='utf-8')
        self.assertIn("tags: ['friends-v*']", source)
        self.assertIn('if: vars.XHARNESS_FRIENDS_RELEASE_REPOSITORY == github.repository', source)
        self.assertIn('XHARNESS_FRIENDS_RELEASE_REPOSITORY: ${{ vars.XHARNESS_FRIENDS_RELEASE_REPOSITORY }}', source)
        self.assertNotIn('yyqdbngt/x-harness-rs', source)
        self.assertNotIn('pull_request_target', source)
        self.assertNotIn('--clobber', source)
        for name in ['PRIVATE_KEY', 'PASSWORD', 'PUBLIC_KEY']:
            self.assertIn('secrets.XHARNESS_FRIENDS_' + name, source)
        self.assertLess(source.index('verify-updater-package.mjs'), source.index('gh release create'))
        self.assertLess(source.index('gh release upload'), source.index('--draft=false --latest'))

    def test_fork_and_upstream_urls_are_isolated(self):
        for repository in ['123123213weqw/x-harness-rs', 'yyqdbngt/x-harness-rs']:
            result = plan(repository, 'friends-v0.2.1', [])
            self.assertEqual(result['endpoint'], f'https://github.com/{repository}/releases/latest/download/latest.json')
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            module.manifest(REPOSITORY, 'friends-v0.2.1', Path(directory), configured_repository='')

    def test_bootstrap_and_rolling_channel(self):
        result = plan(REPOSITORY, 'friends-v0.2.1', [])
        self.assertEqual(result['versions'], ['0.2.0', '0.2.1'])
        self.assertTrue(result['endpoint'].endswith('/releases/latest/download/latest.json'))
        prior = [{'tagName': 'friends-v0.2.1', 'isDraft': False}]
        self.assertEqual(plan(REPOSITORY, 'friends-v0.2.2', prior)['versions'], ['0.2.2'])

    def test_reject_wrong_repository_versions_and_overwrites(self):
        with self.assertRaises(ValueError):
            module.plan(REPOSITORY, 'friends-v0.2.1', [], configured_repository='yyqdbngt/x-harness-rs')
        for value in ['0.2.1\n', '01.2.3', '1;bad', '1.2', '65536.0.1']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.version(value)
        for tag in ['friends-v0.2.0', 'desktop-v0.2.1']:
            with self.assertRaises(ValueError):
                plan(REPOSITORY, tag, [])
        for draft in [False, True]:
            with self.assertRaises(ValueError):
                plan(REPOSITORY, 'friends-v0.2.1', [{'tagName': 'friends-v0.2.1', 'isDraft': draft}])
        with self.assertRaises(ValueError):
            plan(REPOSITORY, 'friends-v0.2.1', [{'tagName': 'friends-v0.2.2', 'isDraft': False}])

    def test_manifest_uses_exact_signed_immutable_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                manifest(REPOSITORY, 'friends-v0.2.1', root)
            (root / 'XHarness_0.2.1_x64-setup.exe').write_bytes(b'test')
            (root / 'XHarness_0.2.1_x64-setup.exe.sig').write_text('test-signature\n')
            result = manifest(REPOSITORY, 'friends-v0.2.1', root)
            platform = result['platforms']['windows-x86_64']
            self.assertEqual(platform['signature'], 'test-signature')
            self.assertEqual(platform['url'], 'https://github.com/123123213weqw/x-harness-rs/releases/download/friends-v0.2.1/XHarness_0.2.1_x64-setup.exe')


if __name__ == '__main__':
    unittest.main()
