#!/usr/bin/env python3
import base64, importlib.util, json, tempfile, unittest
from unittest.mock import patch
from io import BytesIO
from pathlib import Path
p = Path(__file__).with_name('mirror-public-plugin-registry.py')
spec = importlib.util.spec_from_file_location('mirror', p); mirror = importlib.util.module_from_spec(spec); spec.loader.exec_module(mirror)
class MirrorTests(unittest.TestCase):
    def test_validation_message_does_not_expose_credentials_or_raw_html(self):
        self.assertNotIn('secret-token', mirror.safe_api_reason(b'{"message":"secret-token"}', 'secret-token'))
        self.assertEqual(mirror.safe_api_reason(b'<html>secret</html>', 'token'), '')
        self.assertEqual(mirror.safe_api_reason(b'["secret"]', 'token'), '')
    def test_creates_only_authorized_empty_managed_repository(self):
        calls=[]
        def api(path,data=None,method=None):
            calls.append((path,data))
            if path == '/user': return {'login':'wangyue2006'}
            if path.endswith('/branches') or path.endswith('/tags'): return []
            if data is None: raise mirror.Absent()
            return {'private':True,'description':mirror.MARKER}
        self.assertTrue(mirror.ensure_target(api)['private'])
        create = next(data for path,data in calls if path == '/user/repos')
        self.assertEqual(create['private'], 'true')
        self.assertEqual(create['name'], 'xharness-plugin-registry')
        self.assertTrue(all(data is None for path,data in calls if path != '/user/repos'))
    def test_wrong_account_private_or_unrelated_target_is_never_modified(self):
        for user,repo in [('other',{}), ('wangyue2006',{'private':True,'description':mirror.MARKER}),
            ('wangyue2006',{'private':False,'description':'not our mirror'})]:
            def api(path,data=None,method=None):
                self.assertIsNone(data)
                return {'login':user} if path == '/user' else repo
            with self.assertRaises(RuntimeError): mirror.ensure_target(api)
    def test_empty_private_registry_is_validated_but_not_promoted_before_push(self):
        def api(path,data=None,method=None):
            self.assertIsNone(data)
            if path == '/user': return {'login':'wangyue2006'}
            if path.endswith('/branches') or path.endswith('/tags'): return []
            return {'private':True,'description':mirror.MARKER}
        self.assertTrue(mirror.ensure_target(api)['private'])
    def test_interrupted_publication_resumes_only_known_public_main_without_tags(self):
        for branches,tags,accepted in [
            ([{'name':'main','commit':{'sha':'public-sha'}}],[],True),
            ([{'name':'main','commit':{'sha':'private-sha'}}],[],False),
            ([{'name':'secret','commit':{'sha':'public-sha'}}],[],False),
            ([{'name':'main','commit':{'sha':'public-sha'}}],['private-tag'],False),
            ([{},{}],[],False)]:
            def api(path,data=None,method=None):
                self.assertIsNone(data)
                if path == '/user': return {'login':'wangyue2006'}
                if path.endswith('/branches'): return branches
                if path.endswith('/tags'): return tags
                return {'private':True,'description':mirror.MARKER}
            if accepted: self.assertTrue(mirror.ensure_target(api, {'public-sha'})['private'])
            else:
                with self.assertRaises(RuntimeError): mirror.ensure_target(api, {'public-sha'})
    def test_promotion_sets_default_branch_and_requires_confirmed_visibility(self):
        for private in [True, False]:
            def api(path,data=None,method=None):
                self.assertEqual(method, 'PATCH')
                self.assertEqual(data, {'name':'xharness-plugin-registry','private':'false','default_branch':'main'})
                return {'private':private,'description':mirror.MARKER}
            if private:
                with self.assertRaises(RuntimeError): mirror.promote_target(api)
            else: self.assertFalse(mirror.promote_target(api)['private'])
    def test_anonymous_download_verifies_actual_bytes_and_metadata_without_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo=Path(tmp); catalog={'plugins':[{'name':'github','version':'0.2.0'}]}
            (repo/'catalog.json').write_text(json.dumps(catalog))
            package=repo/'packages/github/0.2.0/plugin.zip';package.parent.mkdir(parents=True);package.write_bytes(b'zip-fixture')
            for bad in [None, 'size', 'content', 'type']:
                class Opener:
                    def open(self, request, timeout):
                        self_outer.assertNotIn('Authorization', request.headers)
                        data=(repo/request.full_url.split('/contents/')[1]).read_bytes()
                        envelope={'type':'file','encoding':'base64','size':len(data),
                                  'content':base64.b64encode(data).decode()+'\n'}
                        if bad == 'size': envelope['size']+=1
                        if bad == 'content': envelope['content']='d3Jvbmc='
                        if bad == 'type': envelope['type']='dir'
                        return BytesIO(json.dumps(envelope).encode())
                self_outer=self
                with patch.object(mirror.urllib.request, 'build_opener', return_value=Opener()):
                    if bad is None: mirror.verify_anonymous(repo)
                    else:
                        with self.assertRaises(RuntimeError): mirror.verify_anonymous(repo)
    def test_existing_good_public_repository_is_idempotent(self):
        calls=[]
        def api(path,data=None,method=None):
            calls.append(path); self.assertIsNone(data)
            return {'login':'wangyue2006'} if path == '/user' else {'private':False,'description':mirror.MARKER}
        mirror.ensure_target(api);self.assertEqual(len(calls),2)
if __name__ == '__main__': unittest.main()
