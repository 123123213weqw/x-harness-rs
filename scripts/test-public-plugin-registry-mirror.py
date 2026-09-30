#!/usr/bin/env python3
import importlib.util, unittest
from pathlib import Path
p = Path(__file__).with_name('mirror-public-plugin-registry.py')
spec = importlib.util.spec_from_file_location('mirror', p); mirror = importlib.util.module_from_spec(spec); spec.loader.exec_module(mirror)
class MirrorTests(unittest.TestCase):
    def test_creates_only_authorized_public_repository(self):
        calls=[]
        def api(path,data=None,method=None):
            calls.append((path,data))
            if path == '/user': return {'login':'wangyue2006'}
            if data is None: raise mirror.Absent()
            return {'private':False,'description':mirror.MARKER}
        mirror.ensure_target(api)
        self.assertEqual(calls[-1][0], '/user/repos')
        self.assertEqual(calls[-1][1]['private'], 'false')
        self.assertEqual(calls[-1][1]['public'], '1')
        self.assertEqual(calls[-1][1]['name'], 'xharness-plugin-registry')
    def test_wrong_account_private_or_unrelated_target_is_never_modified(self):
        for user,repo in [('other',{}), ('wangyue2006',{'private':True,'description':mirror.MARKER}),
            ('wangyue2006',{'private':False,'description':'not our mirror'})]:
            def api(path,data=None,method=None):
                self.assertIsNone(data)
                return {'login':user} if path == '/user' else repo
            with self.assertRaises(RuntimeError): mirror.ensure_target(api)
    def test_only_empty_managed_private_target_can_be_promoted(self):
        calls=[]
        def api(path,data=None,method=None):
            calls.append((path,method))
            if path == '/user': return {'login':'wangyue2006'}
            if path.endswith('/branches'): return []
            if method == 'PATCH':
                self.assertEqual(data, {'name':'xharness-plugin-registry','private':'false'})
            return {'private':False if method == 'PATCH' else True,'empty_repo':True,'description':mirror.MARKER}
        mirror.ensure_target(api)
        self.assertEqual(calls[-1], ('/repos/'+mirror.TARGET, 'PATCH'))
    def test_existing_good_public_repository_is_idempotent(self):
        calls=[]
        def api(path,data=None,method=None):
            calls.append(path); self.assertIsNone(data)
            return {'login':'wangyue2006'} if path == '/user' else {'private':False,'description':mirror.MARKER}
        mirror.ensure_target(api);self.assertEqual(len(calls),2)
if __name__ == '__main__': unittest.main()
