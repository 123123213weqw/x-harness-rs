#!/usr/bin/env python3
"""Offline contracts with disposable real signatures, fake GH/HTTPS/SSH boundaries.

These are NOT native installation evidence. No Rust, secrets or network required.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sync', ROOT / 'scripts/engine-release-sync.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
REAL_LIVE_STATE = m.live_state


def manifest(v='0.2.37'):
    return {'version': v, 'notes': 'Public release', 'pub_date': '2026-10-06T15:38:20Z',
        'macos_distribution': m.contract.MACOS_PREVIEW_POLICY,
        'platforms': {p: {'url': f'https://github.com/{m.REPO}/releases/download/desktop-v{v}/{pattern.format(version=v)}',
            'signature': 'fixture'} for p, (_, pattern) in m.contract.PLATFORMS.items()}}


class PureContracts(unittest.TestCase):
    def test_projection_preserves_every_field_except_urls(self):
        source = manifest(); original = copy.deepcopy(source); target = m.project(source)
        self.assertEqual(source, original)
        self.assertEqual({k:v for k,v in source.items() if k != 'platforms'}, {k:v for k,v in target.items() if k != 'platforms'})
        for p in source['platforms']:
            self.assertEqual(target['platforms'][p]['signature'], source['platforms'][p]['signature'])
            self.assertTrue(target['platforms'][p]['url'].startswith(m.ORIGIN + '/downloads/releases/0.2.37/'))

    def test_strict_versions(self):
        for bad in ['', '01.2.3', '1.2', '1.2.3-rc', '1.2.3\n', '../secret', 1, None]:
            with self.subTest(bad=bad), self.assertRaises(ValueError): m.version(bad)
        self.assertGreater(m.version('0.2.100'), m.version('0.2.37'))

    def test_manifest_boundary_cases(self):
        edits = [lambda v:v.update(secret='x'), lambda v:v.update(pub_date='2026-02-30T00:00:00Z'),
            lambda v:v.update(pub_date='2026-01-01'), lambda v:v.update(notes=[]), lambda v:v.update(notes='x'*8192),
            lambda v:v.update(macos_distribution='self-signed-unnotarized-preview'),
            lambda v:v.update(macos_signing_fingerprint='a'*40), lambda v:v['platforms'].pop('windows-x86_64'),
            lambda v:v['platforms'].update(evil={'url':'x','signature':'x'})]
        for edit in edits:
            v=manifest(); edit(v)
            with self.subTest(edit=edit), self.assertRaises(ValueError): m.project(v)

    def test_mutable_external_query_and_traversal_urls_rejected(self):
        for url in ['http://github.com/x', 'https://evil.test/package', 'https://github.com/'+m.REPO+'/releases/latest/download/foo',
                    manifest()['platforms']['windows-x86_64']['url']+'?download=1', m.ORIGIN+'/downloads/releases/../secret']:
            v=manifest(); v['platforms']['windows-x86_64']['url']=url
            with self.subTest(url=url), self.assertRaises(ValueError): m.project(v)

    def test_noop_upgrade_and_downgrade(self):
        target=m.project(manifest()); old=m.project(manifest('0.2.32'))
        self.assertFalse(m.compare(target,target)); self.assertTrue(m.compare(old,target))
        with self.assertRaises(ValueError): m.compare(target,old)
        changed=copy.deepcopy(target); changed['notes']='changed'
        with self.assertRaises(ValueError): m.compare(target,changed)

    def test_platform_and_policy_continuity(self):
        old=m.project(manifest('0.2.32')); new=m.project(manifest())
        new['platforms'].pop('darwin-aarch64')
        with self.assertRaises(ValueError): m.compare(old,new)
        new=m.project(manifest()); new.pop('macos_distribution')
        with self.assertRaises(ValueError): m.compare(old,new)

    def test_duplicate_json_and_inventory_rejected(self):
        for data in [b'{"x":1,"x":2}',b'[]',b'{' + b'x'*m.MAX_METADATA]:
            with self.assertRaises((ValueError,json.JSONDecodeError)): m.decode(data)
        for text in ['', 'a'*64+'  ../secret\n', 'a'*64+'  a\n'+'a'*64+'  a\n', 'A'*64+'  a\n',
                     'a'*64+'  SHA256SUMS\n','a'*64+'  a', 'a'*64+'  z\n'+'a'*64+'  a\n']:
            with self.subTest(text=text), self.assertRaises(ValueError): m.inventory(text)

    def test_public_transport_restricts_https_and_redirects(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'out'; output.write_bytes(b'ok')
            for url in ['http://engine.xxdevs.com/foo','https://evil.test/foo']:
                with self.assertRaises(ValueError): m.curl_public(url,output,100)
            with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout='302')):
                with self.assertRaises(ValueError): m.curl_public(m.ORIGIN+'/foo',output,100)
            with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout='200')) as run:
                m.curl_public(m.ORIGIN+'/foo',output,100)
                args=run.call_args.args[0]
                self.assertIn('-q',args); self.assertIn('=https',args); self.assertNotIn('-L',args)
                self.assertIn('--max-filesize',args); self.assertNotIn('--insecure',args)
                self.assertIn('--retry-all-errors',args)
                self.assertEqual(args[args.index('--retry')+1], '2')
                self.assertEqual(args[args.index('--max-time')+1], '300')
                m.curl_public(m.ORIGIN+'/installer', output, 100, head=True)
                head_args=run.call_args.args[0]
                self.assertIn('--head',head_args)
                self.assertEqual(head_args[head_args.index('--max-filesize')+1],str(m.MAX_TOTAL))
                self.assertEqual(head_args[head_args.index('--max-time')+1],'300')

    def test_truncated_and_oversize_public_payloads(self):
        def fake(url,path,limit,**kwargs): path.write_bytes(b'123')
        with patch.object(m,'curl_public',side_effect=fake):
            with self.assertRaises(ValueError): m.public_get(m.ORIGIN+'/a',expected_size=4)
            with self.assertRaises(ValueError): m.public_digest(m.ORIGIN+'/downloads/releases/0.2.37/a',4)
        with patch.object(m,'public_get_head',return_value='HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n'):
            m.public_head(m.ORIGIN+'/a',3)
            with self.assertRaises(ValueError): m.public_head(m.ORIGIN+'/a',4)


class Pipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(); cls.addClassCleanup(cls.temp.cleanup)
        cls.fixture=Path(cls.temp.name)/'fixture'; cls.fixture.mkdir()
        ci={'id':101,'run_attempt':1,'head_sha':'a'*40,'head_branch':'master','event':'push','status':'completed',
            'conclusion':'success','path':'.github/workflows/ci.yml'}
        cls.plan=m.contract.make_plan(m.REPO,m.REPO,'desktop-v0.2.37','a'*40,'1234','1',[],[ci],release_scope='all-macos-preview')
        source=manifest(); source['notes']=m.contract.manifest_notes(cls.plan)
        m.write(cls.fixture/'latest.json',source)
        cls.packages=list(m.package_names(source,origin='github').values())
        for name in cls.packages: (cls.fixture/name).write_bytes(b'Synthetic signed package, NOT an installer: '+name.encode())
        subprocess.run(['node',str(ROOT/'scripts/engine-sync-signature-fixture.mjs'),str(cls.fixture),*cls.packages,'latest.json'],check=True)
        (cls.fixture/'latest.json.sig').unlink()
        cls.pin=m.contract.public_key(cls.fixture/'updater.pub')[1]
        source=m.load(cls.fixture/'latest.json')
        for platform,name in m.package_names(source,origin='github').items():
            receipt={k:v for k,v in cls.plan.items() if k!='endpoint'}
            receipt.update(platform=platform,target=m.contract.PLATFORMS[platform][0],package=name,
                package_sha256=m.sha(cls.fixture/name),package_size=(cls.fixture/name).stat().st_size,
                signature=(cls.fixture/(name+'.sig')).read_text().strip(),public_key_sha256=cls.pin,
                binary_sha256='b'*64,embedded_endpoint=cls.plan['endpoint'],identifier=m.contract.IDENTIFIER)
            m.write(cls.fixture/(platform+'.receipt.json'),receipt)
        evidence={'schema_version':1,'status':'candidate-verified-not-native-accepted','plan':cls.plan,
            'manifest_sha256':m.sha(cls.fixture/'latest.json'),'public_key_sha256':cls.pin,
            'receipts':{p:m.sha(cls.fixture/(p+'.receipt.json')) for p in source['platforms']}}
        m.write(cls.fixture/'release-evidence.json',evidence)
        (cls.fixture/'SHA256SUMS').write_text(m.contract.checksums(cls.fixture))
        m.contract.validate_release(cls.plan,cls.fixture,cls.fixture/'updater.pub')

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup); self.root=Path(self.temp.name)
        self.fixture=self.root/'source-fixture'; shutil.copytree(type(self).fixture,self.fixture)
        self.work=self.root/'work'
        assets=[{'id':i+1,'name':p.name,'size':p.stat().st_size,'digest':'sha256:'+m.sha(p),
            'state':'uploaded','created_at':'2026-10-06T00:00:00Z','updated_at':'2026-10-06T00:00:00Z'}
            for i,p in enumerate(self.fixture.iterdir())]
        self.release={'id':42,'tag_name':'desktop-v0.2.37','target_commitish':'a'*40,'name':'test','body':'test',
            'draft':False,'prerelease':False,'created_at':'2026-10-06T00:00:00Z','published_at':'2026-10-06T01:00:00Z','assets':assets}
        self.target=m.project(m.load(self.fixture/'latest.json'))
        self.old=m.project(manifest('0.2.32'))
        self.baseline='b'*64
        for target,kwargs in [
            ((m,'KEY_HASH'),{'new':self.pin}), ((m,'latest'),{'return_value':self.release}),
            ((m,'live_state'),{'return_value':(self.old,self.baseline)}),
            ((m,'promotion_proof'),{'return_value':{'run_id':99,'native_acceptance_sha256':{p:'c'*64 for p in self.target['platforms']}}}),
            ((m,'fetch_notices'),{'side_effect':lambda plan,dest:[(dest/n).write_text('Retained notice') for n in ['LICENSE','THIRD_PARTY_NOTICES.md']]}),
            ((m.build,'download_release'),{'side_effect':self.download})]:
            obj,attr=target; patcher=patch.object(obj,attr,**kwargs); mocked=patcher.start(); self.addCleanup(patcher.stop)
            if attr=='promotion_proof': self.proof_mock=mocked
            if attr=='download_release': self.download_mock=mocked

    def download(self,repo,tag,dest,names):
        Path(dest).mkdir()
        for name in names: shutil.copyfile(self.fixture/name,Path(dest)/name)

    def prepare(self): return m.prepare(self.work)

    def sealed(self):
        self.prepare(); export=self.work/'export'
        # Re-key this isolated export only, with a fresh disposable signer. Real
        # CI retains the production key and ORIGINAL package bytes/signatures.
        subprocess.run(['node',str(ROOT/'scripts/engine-sync-signature-fixture.mjs'),str(export),*self.packages,'latest.json'],check=True)
        pin=m.contract.public_key(export/'updater.pub')[1]
        receipt=m.load(self.work/'audit/prepare.json'); receipt['target']=m.load(export/'latest.json')
        receipt['manifest_sha256']=m.sha(export/'latest.json')
        info=m.load(export/'release.json'); info.update(public_key_sha256=pin,manifest_sha256=receipt['manifest_sha256']);m.write(export/'release.json',info)
        receipt['export_inventory']={p.name:m.sha(p) for p in export.iterdir() if p.name!='latest.json.sig'}
        m.write(self.work/'audit/prepare.json',receipt)
        self.addCleanup(patch.stopall)
        patch.object(m,'KEY_HASH',pin).start()
        m.seal(self.work)
        return m.load(self.work/'audit/prepare.json')

    def test_real_signatures_full_prepare_no_rust_no_signing_no_publication(self):
        result=self.prepare()
        self.assertEqual(result['state'],'prepared-unsigned-not-published')
        self.assertTrue(result['sync_needed']); self.proof_mock.assert_called_once()
        self.assertFalse((self.work/'export/latest.json.sig').exists())
        for name in self.packages:
            self.assertEqual((self.fixture/name).read_bytes(),(self.work/'export'/name).read_bytes())
            self.assertEqual((self.fixture/(name+'.sig')).read_bytes(),(self.work/'export'/(name+'.sig')).read_bytes())

    def test_noop_skips_native_artifact_download_packages_signing_and_publish(self):
        with patch.object(m,'live_state',return_value=(self.target,hashlib.sha256(m.encoded(self.target)).hexdigest())),patch.object(m,'catalog_check'):
            self.assertFalse(self.prepare()['sync_needed'])
        self.proof_mock.assert_not_called(); self.assertEqual(self.download_mock.call_count,1)
        self.assertFalse((self.work/'export').exists())

    def test_draft_prerelease_and_duplicate_assets_rejected(self):
        for update in [{'draft':True},{'prerelease':True},{'tag_name':'friends-v0.2.37'},{'assets':self.release['assets']*2}]:
            value={**self.release,**update}
            with self.subTest(update=update),self.assertRaises(ValueError): m.selected_release(value)

    def test_checksum_and_size_and_asset_digest_tamper(self):
        assets={a['name']:a for a in self.release['assets']}
        sums=m.inventory((self.fixture/'SHA256SUMS').read_text())
        name=self.packages[0]
        for field,value in [('size',1),('digest','sha256:'+'c'*64)]:
            changed=copy.deepcopy(assets);changed[name][field]=value
            with self.assertRaises(ValueError): m.verify_downloads(self.fixture,{name},changed,sums)
        sums[name]='c'*64
        with self.assertRaises(ValueError): m.verify_downloads(self.fixture,{name},assets,sums)

    def test_missing_or_oversized_assets_rejected(self):
        snapshot=m.selected_release(self.release)
        with self.assertRaises(ValueError): m.check_assets(snapshot,{'secret.env'})
        snapshot['assets'][0]['size']=m.MAX_TOTAL+1
        with self.assertRaises(ValueError): m.check_assets(snapshot,{snapshot['assets'][0]['name']})

    def test_reject_missing_native_proof_before_package_download(self):
        self.proof_mock.side_effect=ValueError('No native proof')
        with self.assertRaises(ValueError): self.prepare()
        self.assertEqual(self.download_mock.call_count,1)

    def test_detect_latest_release_race(self):
        with patch.object(m,'latest',side_effect=[self.release,{**self.release,'name':'mutated'}]):
            with self.assertRaises(ValueError): self.prepare()
        self.assertFalse((self.work/'audit/prepare.json').exists())

    def test_detect_baseline_race(self):
        with patch.object(m,'live_state',side_effect=[(self.old,self.baseline),(self.old,'c'*64)]):
            with self.assertRaises(ValueError): self.prepare()

    def test_sealed_export_flat_deterministic_inventory(self):
        self.sealed(); receipt,files=m.export_files(self.work)
        with tarfile.open(self.work/'upload.tar') as stream:
            self.assertEqual(set(stream.getnames()),set(files))
            for entry in stream:
                self.assertTrue(entry.isfile()); self.assertFalse(entry.pax_headers)
                self.assertEqual(entry.mode,0o444); self.assertEqual(entry.mtime,0)
                self.assertNotIn('/',entry.name)
        with self.assertRaises((ValueError,FileExistsError)): m.seal(self.work)

    def test_export_extra_private_file_symlink_or_mutated_payload_rejected(self):
        self.sealed(); export=self.work/'export'
        (export/'.env').write_text('Never export')
        with self.assertRaises(ValueError): m.export_files(self.work)
        (export/'.env').unlink(); name=self.packages[0]
        original=(export/name).read_bytes(); (export/name).write_bytes(b'changed')
        with self.assertRaises(ValueError): m.export_files(self.work)
        (export/name).unlink(); outside=self.root/'outside'; outside.write_bytes(original); (export/name).symlink_to(outside)
        with self.assertRaises(ValueError): m.export_files(self.work)

    def test_changed_upload_and_cas_prevent_any_ssh_execution(self):
        self.sealed()
        for edit in [lambda:(self.work/'upload.tar').write_bytes(b'changed')]:
            edit()
            with patch.object(m,'ssh_arguments') as ssh,self.assertRaises(ValueError): m.publish(self.work,self.root/'key',self.root/'hosts')
            ssh.assert_not_called()

    def test_baseline_changed_after_seal_never_sends_ssh(self):
        self.sealed()
        with patch.object(m,'export_files',wraps=m.export_files),patch.object(m,'live_state',return_value=(self.old,'c'*64)),patch.object(m,'ssh_arguments') as ssh:
            with self.assertRaises(ValueError): m.publish(self.work,self.root/'key',self.root/'hosts')
            ssh.assert_not_called()

    def test_ssh_lost_reply_is_reconciled_without_resend(self):
        receipt=self.sealed()
        with patch.object(m,'export_files',return_value=(receipt,{})),patch.object(m,'ssh_arguments',return_value=['ssh']), \
            patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired('ssh',1200)) as ssh, \
            patch.object(m,'smoke',return_value={'state':'published-https-payloads-verified'}) as smoke:
            result=m.publish(self.work,self.root/'key',self.root/'hosts')
            self.assertEqual(result['ssh_reply'],'unknown-but-publication-independently-verified')
            self.assertEqual(ssh.call_count,1); self.assertEqual(smoke.call_count,1)

    def test_unknown_or_partial_publication_never_blindly_resends_or_cleans_server(self):
        receipt=self.sealed()
        with patch.object(m,'export_files',return_value=(receipt,{})),patch.object(m,'ssh_arguments',return_value=['ssh']), \
            patch.object(m.subprocess,'run',side_effect=subprocess.CalledProcessError(2,'ssh')) as ssh, \
            patch.object(m,'smoke',side_effect=ValueError('partial')),patch.object(m.time,'sleep'):
            with self.assertRaises(ValueError): m.publish(self.work,self.root/'key',self.root/'hosts')
            self.assertEqual(ssh.call_count,1)
            self.assertEqual(m.load(self.work/'audit/publication-result.json')['state'],'outcome-unverified-inspect-before-retry')

    def test_resume_already_accepted_publication_only_reads_back(self):
        receipt=self.sealed()
        with patch.object(m,'export_files',return_value=(receipt,{})),patch.object(m,'live_state',return_value=(receipt['target'],receipt['manifest_sha256'])), \
            patch.object(m,'ssh_arguments') as ssh,patch.object(m,'smoke',return_value={'state':'verified'}):
            self.assertEqual(m.publish(self.work,self.root/'key',self.root/'hosts')['state'],'verified')
            ssh.assert_not_called()

    def test_signature_key_and_comment_tampering_rejected(self):
        self.sealed(); export=self.work/'export'
        p=export/'latest.json.sig'; p.write_text(p.read_text()[:-8]+'AAAAAA\n')
        (export/'SHA256SUMS').write_text(m.contract.checksums(export))
        with self.assertRaises(ValueError): m.export_files(self.work)

    def test_only_pinned_unsigned_bootstrap_exception(self):
        source=self.fixture/'latest.json'; data=source.read_bytes()
        def public(url):
            return (self.fixture/'updater.pub').read_bytes() if url.endswith('updater.pub') else data
        with patch.object(m,'public_get',side_effect=public):
            with self.assertRaises(ValueError): REAL_LIVE_STATE()

    def test_proof_must_match_native_acceptance_and_published_snapshot(self):
        evidence=m.load(self.fixture/'release-evidence.json'); snapshot=m.selected_release(self.release)
        proof=self.root/'proof'; proof.mkdir()
        promotion={'schema_version':1,'status':'promotion-authorized','plan':self.plan,'manifest_sha256':evidence['manifest_sha256'],
            'public_key_sha256':self.pin,'acceptance_sha256':{p:'c'*64 for p in self.target['platforms']}}
        result={'state':'published_and_verified','release_id':42,'public':{'sha256':{'latest.json':evidence['manifest_sha256']}}}
        m.write(proof/'promotion.json',promotion);m.write(proof/'published.json',snapshot);m.write(proof/'publication-result.json',result)
        m.validate_proof(proof,snapshot,evidence)
        for edit in [lambda v:v.update(status='candidate-verified-not-native-accepted'),lambda v:v['acceptance_sha256'].pop('darwin-aarch64'),
                     lambda v:v.update(manifest_sha256='d'*64),lambda v:v.update(public_key_sha256='d'*64)]:
            changed=copy.deepcopy(promotion);edit(changed);m.write(proof/'promotion.json',changed)
            with self.assertRaises(ValueError): m.validate_proof(proof,snapshot,evidence)
        m.write(proof/'promotion.json',promotion);m.write(proof/'published.json',{**snapshot,'name':'changed'})
        with self.assertRaises(ValueError): m.validate_proof(proof,snapshot,evidence)

    def test_ssh_options_force_host_checks_no_agent_no_shell_fallback(self):
        key=self.root/'key';hosts=self.root/'hosts'; key.write_text('fixture');hosts.write_text('fixture')
        args=m.ssh_arguments(key,hosts)
        for value in ['StrictHostKeyChecking=yes','ForwardAgent=no','ClearAllForwardings=yes','IdentitiesOnly=yes','/dev/null']:
            self.assertIn(value,args)
        self.assertEqual(args[-1],'xs@222.186.10.53')


class WorkflowContracts(unittest.TestCase):
    def test_triggers_secrets_and_trusted_code_separation(self):
        text=(ROOT/'.github/workflows/sync-engine-releases.yml').read_text()
        for expected in ['workflow_run:', "workflows: ['Desktop Promote']", 'schedule:', 'workflow_dispatch:', 'default: true',
                         "ref: master", "github.event_name != 'pull_request'", "XHARNESS_ENGINE_RELEASE_SYNC_ENABLED", 'cancel-in-progress: false',
                         'XHARNESS_ENGINE_RELEASE_SSH_KEY', 'XHARNESS_ENGINE_RELEASE_KNOWN_HOSTS', "head_repository.full_name == github.repository"]:
            self.assertIn(expected,text)
        for prohibited in ['cargo build','tauri build','systemctl','rsync','scp ','pull_request_target','XHARNESS_PLUGIN_PUBLISH_SSH_KEY']:
            self.assertNotIn(prohibited,text)
        self.assertIn('path: dist/engine-sync/audit/',text)
        self.assertNotIn('path: dist/engine-sync/export/\n',text)
        self.assertIn('timeout-minutes: 350',text)
        self.assertIn('name: engine-release-signed-envelope',text)
        self.assertNotIn('dist/engine-sync/export/*\n',text)


if __name__=='__main__': unittest.main(verbosity=2)
