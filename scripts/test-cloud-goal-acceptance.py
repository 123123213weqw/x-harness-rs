#!/usr/bin/env python3
"""Offline guards; never reads real credentials, SSH, VM or model endpoints."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import json
import urllib.request
spec=importlib.util.spec_from_file_location('goal_acceptance',Path(__file__).with_name('cloud-goal-acceptance.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Guards(unittest.TestCase):
    def test_optional_counting_endpoint_is_unsupported_not_auth_failure_or_fake_exact_count(self):
        relay=module.Relay({'base_url':'https://api.deepseek.com','model':'deepseek-flash','api_key':'not-a-real-key'})
        try:
            for token,status in [(relay.token,404),('',403)]:
                request=urllib.request.Request('http://127.0.0.1:'+str(relay.server.server_port)+'/v1/chat/completions/input_tokens',data=b'{}',headers={'Authorization':'Bearer '+token})
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request,timeout=2)
                self.assertEqual(error.exception.code,status)
            self.assertEqual(relay.count(),0)
        finally:relay.stop()
    def test_adjacent_tagged_original_session_events_count_creation_not_goal_progress(self):
        events=[{'type':'goal/change','data':{'operation':'create','goal':{'id':'goal-1'}}},
            {'type':'goal/change','data':{'operation':'advance','goal':{'id':'goal-1'}}},
            {'type':'goal/execution','data':{'change':{'state':{'rounds_started':2,'latest_turn':{'report':{'status':'complete'}},'running':None,'pending':None}}}}]
        result=module.summarize_events(events)
        self.assertEqual(result['goal_creates'],1);self.assertEqual(result['goal_id'],'goal-1');self.assertEqual(result['rounds_started'],2);self.assertEqual(result['report_status'],'complete')
    def test_model_credentials_require_private_regular_bounded_file(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'config';path.write_text('{}');path.chmod(0o644)
            with self.assertRaises(RuntimeError):module.config_read(path)
            path.chmod(0o600);self.assertEqual(module.config_read(path),{})
            linked=Path(root)/'link';linked.symlink_to(path)
            with self.assertRaises(RuntimeError):module.config_read(linked)
            path.write_bytes(b'a'*16385)
            with self.assertRaises(RuntimeError):module.config_read(path)
    def test_relay_rejects_arbitrary_vendor_model_and_empty_key_before_opening(self):
        for config in [{'base_url':'http://127.0.0.1','model':'deepseek-flash','api_key':'fixture'},{'base_url':'https://api.deepseek.com','model':'other','api_key':'fixture'},{'base_url':'https://api.deepseek.com','model':'deepseek-flash','api_key':''}]:
            with self.assertRaises(RuntimeError):module.Relay(config)
    def test_scoped_relay_rejects_missing_authorization_and_wrong_path_without_model_call(self):
        relay=module.Relay({'base_url':'https://api.deepseek.com','model':'deepseek-flash','api_key':'not-a-real-key'})
        try:
            for path,token in [('/v1/chat/completions',''),('/anything',relay.token)]:
                request=urllib.request.Request('http://127.0.0.1:'+str(relay.server.server_port)+path,data=b'{}',headers={'Authorization':'Bearer '+token})
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request,timeout=2)
                self.assertEqual(error.exception.code,403)
            self.assertEqual(relay.count(),0)
        finally:relay.stop()
    def test_authenticated_unsupported_or_oversize_body_never_reaches_vendor(self):
        relay=module.Relay({'base_url':'https://api.deepseek.com','model':'deepseek-flash','api_key':'not-a-real-key'})
        try:
            for body in [{},{'model':'other','stream':True,'max_tokens':8192},{'model':'deepseek-flash','stream':True,'max_tokens':8193}]:
                request=urllib.request.Request('http://127.0.0.1:'+str(relay.server.server_port)+'/v1/chat/completions',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+relay.token})
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request,timeout=2)
                self.assertEqual(error.exception.code,400)
            self.assertEqual(relay.count(),0)
        finally:relay.stop()
if __name__=='__main__':unittest.main()
