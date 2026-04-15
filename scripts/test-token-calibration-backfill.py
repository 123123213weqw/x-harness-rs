#!/usr/bin/env python3
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('backfill',Path(__file__).with_name('backfill-token-calibration.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
    def setUp(self):
        self.fixture=json.loads(Path(__file__).with_name('fixtures').joinpath('token-calibration-wire-v2.json').read_text())
        r=self.fixture['request'];self.messages=r['messages'];self.tools=r['tools']
        self.profile={'id':'provider','protocol':'chat','base_url':'http://localhost:1234/v1'}
        self.model={'id':'fixture-model'}
        self.header={'provider':'provider','model':'fixture-model','options':{'tokenBudget':{'meter':'wire-calibration/v1:'+self.fixture['expected']['legacy_scope'],'selectedOutputTokens':32000}}}
        self.usage={'input_tokens':100,'cache_read_tokens':900,'cache_write_tokens':0}
    def sample(self,**kw):
        args=dict(header=self.header,messages=self.messages,tools=self.tools,usage=self.usage,timestamp=1000,profile=self.profile,model=self.model,semantics='auto',now=2000);args.update(kw);return m.sample(**args)
    def test_rust_fixture_and_normalized_usage(self):
        scope,row=self.sample();self.assertEqual(scope,self.fixture['expected']['scope']);self.assertEqual(row['features'],self.fixture['expected']['features']);self.assertEqual(row['actual'],1000);self.assertEqual(row['observed_at_ms'],1000)
    def test_changed_endpoint_model_protocol_tools_and_patch_rejected(self):
        for patch in [{'base_url':'http://other/v1'},{'protocol':'responses'}]:
            with self.assertRaises(ValueError):self.sample(profile=dict(self.profile,**patch))
        with self.assertRaises(ValueError):self.sample(model={'id':'fixture-model','upstream_model':'other'})
        with self.assertRaises(ValueError):self.sample(tools=[])
        h=copy.deepcopy(self.header);h['options']['tokenBudget']['meter']='wire-calibration/v1:'+'f'*64
        with self.assertRaises(ValueError):self.sample(header=h)
    def test_expiry_future_missing_usage_and_images(self):
        for changes in [{'timestamp':3000},{'now':m.TTL+1001},{'usage':{}},{'usage':{'input_tokens':-1}},{'messages':[dict(self.messages[0],content_blocks=[{'type':'image'}])]}]:
            with self.assertRaises(ValueError):self.sample(**changes)
    def test_corrupt_blob_path_traversal_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);data=b'{"ok":true}';key=hashlib.sha256(data).hexdigest();p=root/(key+'.json');p.write_bytes(data)
            self.assertEqual(m.read_blob(root,key),{'ok':True});p.write_bytes(b'corrupt')
            with self.assertRaises(ValueError):m.read_blob(root,key)
            with self.assertRaises(ValueError):m.read_blob(root,'../outside')
            p.unlink();outside=root/'outside';outside.write_bytes(data);p.symlink_to(outside)
            with self.assertRaises(ValueError):m.read_blob(root,key)
    def test_repeated_requests_cannot_fake_eight_samples(self):
        _,row=self.sample();rows=[row]
        self.assertEqual(m.estimate(rows,row['features']),m.units(row['features']))
    def test_float_wire_fails_closed(self):
        with self.assertRaises(ValueError):m.canonical({'x':1.5})
    def make_journal(self, root, duplicate_header=False, wrong_step=False):
        audit=root/'request-audit';audit.mkdir()
        def blob(v):
            b=m.canonical(v);h=hashlib.sha256(b).hexdigest();(audit/(h+'.json')).write_bytes(b);return h
        events=[]
        for step in range(1,10):
            messages=[{'role':'user','content':str(step)+'x'*10000}]
            header=copy.deepcopy(self.header)
            header['options']['measurement']={'turn':1,'step':step}
            # Tools/controls remain identical; messages may legitimately differ.
            manifest={'version':1,'header':copy.deepcopy(header),'input':[blob(x) for x in messages], 'tools':blob(self.tools),'system':blob('')}
            header['options'].update({'auditSnapshot':{'kind':'archive','version':1,'sha256':blob(manifest)},'inputMessageCount':1,'toolCount':len(self.tools)})
            def event(t,d): events.append({'seq':len(events)+1,'timestamp_ms':1000+step,'event':{'type':t,'data':d}})
            event('request/header',{'header':header})
            if duplicate_header:event('request/header',{'header':header})
            event('assistant/message',{'turn':1,'step':step+1 if wrong_step else step,'usage':self.usage,'message':{'role':'assistant','content':'ok'}})
            event('step/end',{'turn':1,'step':step})
        journal=root/'session.jsonl';journal.write_text(json.dumps({'events':events})+'\n')
        return journal
    def test_full_audit_pairing_and_unmodified_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);journal=self.make_journal(root);before=journal.read_bytes()
            profile=dict(self.profile,models=[self.model])
            snapshot,report=m.recover(journal,{'providers':[profile]},'provider','fixture-model','auto',2000)
            self.assertEqual(report['samples'],9);self.assertEqual(journal.read_bytes(),before)
            self.assertNotIn('xxxxxxxx',m.canonical(snapshot).decode())
            with self.assertRaises(ValueError):m.recover(journal,{'providers':[profile]},'provider','fixture-model','uncached_input',2000)
    def test_ambiguous_and_mismatched_step_responses_are_not_imported(self):
        for flags in [{'duplicate_header':True},{'wrong_step':True}]:
            with tempfile.TemporaryDirectory() as tmp:
                journal=self.make_journal(Path(tmp),**flags)
                with self.assertRaises(ValueError):m.recover(journal,{'providers':[dict(self.profile,models=[self.model])]},'provider','fixture-model','auto',2000)
if __name__=='__main__':unittest.main()
