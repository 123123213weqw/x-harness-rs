import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('distribution', Path(__file__).with_name('plugin-distribution.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def package(name='demo', extra=None):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w') as z:
        z.writestr(name + '/.claude-plugin/plugin.json', json.dumps({'name': name}))
        z.writestr(name + '/skills/pr/SKILL.md', '---\nname: pr\ndescription: Test\n---\nRead only.\n')
        if extra: z.writestr(*extra)
    return b.getvalue()

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.registry = self.root / 'registry'; self.registry.mkdir()
        def git(*args):
            return subprocess.run(['git', '-C', str(self.registry), *args], check=True, capture_output=True)
        git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture')
        git('remote', 'add', 'origin', 'https://github.com/123123213weqw/xharness-plugin-registry.git')
        b = package(); relative = 'packages/demo/1.0/plugin.zip'
        p = self.registry / relative; p.parent.mkdir(parents=True); p.write_bytes(b)
        self.catalog = {'plugins': [{'name': 'demo', 'version': '1.0', 'description': 'Public test',
            'source': {'source': 'url', 'type': 'zip', 'url': m.SOURCE + relative, 'sha256': m.digest(b)}}]}
        self.save(); git('add', '.'); git('commit', '-m', 'fixture')
        self.export = self.root / 'export'; self.destination = self.root / 'wwwroot/plugins'; self.state = self.root / 'private'
    def save(self): (self.registry / 'catalog.json').write_bytes(m.encode(self.catalog))
    def prepare(self): return m.prepare(self.registry, self.export)
    def test_prepare_binding_and_runtime_snapshot(self):
        result = self.prepare(); self.assertEqual(result['plugins'], 1)
        c = json.loads((self.export / 'catalog.json').read_bytes())
        self.assertEqual(c['plugins'][0]['source']['url'], m.ORIGIN + 'packages/demo/1.0/plugin.zip')
        self.assertEqual(c['plugins'][0]['source']['sha256'], self.catalog['plugins'][0]['source']['sha256'])
    def test_unvetted_url_rejected(self):
        self.catalog['plugins'][0]['source']['url'] = 'https://example.com/private.zip'; self.save()
        with self.assertRaises(ValueError): self.prepare()
    def test_identity_traversal_rejected(self):
        self.catalog['plugins'][0]['version'] = '../secret'; self.save()
        with self.assertRaises(ValueError): self.prepare()
    def test_duplicate_name_rejected(self):
        self.catalog['plugins'] *= 2; self.save()
        with self.assertRaises(ValueError): self.prepare()
    def test_package_digest_rejected(self):
        (self.registry / 'packages/demo/1.0/plugin.zip').write_bytes(b'changed')
        with self.assertRaises(ValueError): self.prepare()
    def test_source_symlink_rejected(self):
        p = self.registry / 'packages/demo/1.0/plugin.zip'; original = p.read_bytes(); p.unlink()
        other = self.root / 'private.zip'; other.write_bytes(original); p.symlink_to(other)
        with self.assertRaises(ValueError): self.prepare()
    def test_active_icons_and_bad_zip_rejected(self):
        for data in [b'<svg><script>alert(1)</script></svg>', b'<svg onload="x"/>', b'<svg><image href="http://private/"/></svg>',
                     b'<svg><style>@import "http://private/";</style></svg>', b'<svg><set attributeName="onload" to="alert(1)"/></svg>']:
            with self.assertRaises(ValueError): m.checked_svg(data)
        with self.assertRaises(ValueError): m.checked_zip(package(extra=('../escape', 'bad')), 'demo')
        with self.assertRaises(ValueError): m.checked_zip(package(name='other'), 'demo')
    def test_inventory_rejects_extra_file(self):
        self.prepare(); (self.export / 'secret').write_text('not public')
        with self.assertRaises(ValueError): m.verify(self.export)
    def test_inventory_rejects_tamper(self):
        self.prepare(); (self.export / 'packages/demo/1.0/plugin.zip').write_bytes(b'different')
        with self.assertRaises(ValueError): m.verify(self.export)
    def test_publish_is_idempotent_and_leaves_updates_and_installers_unchanged(self):
        self.prepare(); other = self.destination.parent / 'downloads/catalog.json'; other.parent.mkdir(parents=True); other.write_text('installer marker')
        self.assertTrue(m.publish(self.export, self.destination, self.state)['published'])
        first = (self.destination / 'catalog.json').read_bytes()
        m.publish(self.export, self.destination, self.state)
        self.assertEqual(first, (self.destination / 'catalog.json').read_bytes()); self.assertEqual(other.read_text(), 'installer marker')
    def test_immutable_conflict_does_not_switch_catalog(self):
        self.prepare(); m.publish(self.export, self.destination, self.state)
        old = (self.destination / 'catalog.json').read_bytes()
        (self.destination / 'packages/demo/1.0/plugin.zip').write_bytes(b'external change')
        with self.assertRaises(ValueError): m.publish(self.export, self.destination, self.state)
        self.assertEqual(old, (self.destination / 'catalog.json').read_bytes())
    def test_public_destination_symlink_denied(self):
        self.prepare(); self.destination.parent.mkdir(); other = self.root / 'other'; other.mkdir(); self.destination.symlink_to(other)
        with self.assertRaises(ValueError): m.publish(self.export, self.destination, self.state)
    def test_receiver_normal_and_repeat(self):
        self.prepare(); tar = self.root / 'upload.tar'; hashes = m.bundle(self.export, tar)
        command = f'publish-plugins v1 {hashes["manifest"]} {hashes["archive"]}'
        for _ in range(2): self.assertTrue(m.receive(self.destination, self.state, command, io.BytesIO(tar.read_bytes()))['published'])
    def test_receiver_command_and_digest_denied(self):
        for command in ['sh', 'publish v1 ' + 'a'*64 + ' ' + 'b'*64, 'publish-plugins v1 ' + 'a'*64 + ' ' + 'b'*64]:
            with self.assertRaises(ValueError): m.receive(self.destination, self.state, command, io.BytesIO(b'bad'))
    def test_receiver_tar_traversal_denied(self):
        b = io.BytesIO()
        with tarfile.open(fileobj=b, mode='w') as tar:
            item = tarfile.TarInfo('../escape'); item.size = 1; tar.addfile(item, io.BytesIO(b'x'))
        data = b.getvalue(); command = 'publish-plugins v1 ' + 'a'*64 + ' ' + m.digest(data)
        with self.assertRaises(ValueError): m.receive(self.destination, self.state, command, io.BytesIO(data))
        self.assertFalse((self.state / 'escape').exists())

    def test_public_smoke_verifies_every_file_and_rejects_changed_bytes(self):
        self.prepare(); seen = []
        class Response(io.BytesIO):
            status = 200
        class Opener:
            def open(_, url, timeout):
                self.assertEqual(timeout, 30)
                self.assertTrue(url.startswith(m.ORIGIN))
                name = url[len(m.ORIGIN):]; seen.append(name)
                return Response((self.export / name).read_bytes())
        with patch.object(m.urllib.request, 'build_opener', return_value=Opener()) as build:
            result = m.smoke(self.export)
            self.assertEqual(set(seen), set(m.verify(self.export)['files']))
            self.assertEqual(result['files'], len(seen))
            self.assertIsNone(build.call_args.args[0]().redirect_request(None, None, None, None, None, None))
        class Changed:
            def open(_, url, timeout): return Response(b'corrupted public file')
        with patch.object(m.urllib.request, 'build_opener', return_value=Changed()):
            with self.assertRaises(ValueError): m.smoke(self.export)

    def test_ci_publisher_is_separate_pinned_and_never_uses_shell_or_installer_receiver(self):
        repo = Path(__file__).resolve().parent.parent
        workflow = (repo / '.github/workflows/sync-plugin-distribution.yml').read_text()
        for required in ['XHARNESS_PLUGIN_PUBLISH_SSH_KEY', 'XHARNESS_PLUGIN_PUBLISH_KNOWN_HOSTS',
                         'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'IdentitiesOnly=yes',
                         'publish-plugins v1', 'smoke --export plugin-export', 'cancel-in-progress: false']:
            self.assertIn(required, workflow)
        for denied in ['StrictHostKeyChecking=no', 'ssh-keyscan', 'ForwardAgent=yes',
                       'XHARNESS_DISTRIBUTION_SSH_KEY', 'updates/stable', 'downloads/catalog', 'scp ']:
            self.assertNotIn(denied, workflow)

    def test_restricted_relay_cannot_select_destination_or_run_shell(self):
        relay_spec = importlib.util.spec_from_file_location('relay', Path(__file__).with_name('plugin-publish-relay.py'))
        relay = importlib.util.module_from_spec(relay_spec); relay_spec.loader.exec_module(relay)
        for command in ['', 'true', 'sh', 'forward-engine-plugins v1; sh', 'forward-engine-plugins v2']:
            with patch.dict(relay.os.environ, {'SSH_ORIGINAL_COMMAND': command}), patch.object(relay.os, 'execv') as execute, patch.object(relay.sys, 'stderr', io.StringIO()):
                self.assertEqual(relay.main(), 2); execute.assert_not_called()
        with patch.dict(relay.os.environ, {'SSH_ORIGINAL_COMMAND': 'forward-engine-plugins v1', 'HOST': '127.0.0.1', 'PORT': '9999'}), patch.object(relay.os, 'execv') as execute:
            relay.main()
            execute.assert_called_once_with('/usr/bin/timeout', ['/usr/bin/timeout', '180', '/usr/bin/nc', '-w', '30', '222.186.10.53', '22'])

if __name__ == '__main__': unittest.main()
