import unittest
from fixture_identity import FixtureScopeError, require_active_fixture
URL='http://10.0.2.2:18106/expanded.html?case=filter'
def observation(value=URL):
 return {'ok':True,'result':{'surfaces':[{'surface_id':'active','frontmost':True},{'surface_id':'background','frontmost':False}], 'accessibility':{'nodes':[{'surface_id':'active','role':'edit','value_state':'known','value':value}]}}}
class ScopeTests(unittest.TestCase):
 def test_current_exact_address(self):
  self.assertEqual(require_active_fixture(observation(),URL),'active')
 def test_edge_omits_http_prefix(self):
  self.assertEqual(require_active_fixture(observation(URL.removeprefix('http://')),URL),'active')
 def test_old_port_cannot_be_rescued_by_background_address(self):
  v=observation(URL.replace('18106','18103'));n=dict(v['result']['accessibility']['nodes'][0]);n.update(surface_id='background',value=URL);v['result']['accessibility']['nodes'].append(n)
  with self.assertRaises(FixtureScopeError):require_active_fixture(v,URL)
 def test_wrong_case(self):
  with self.assertRaises(FixtureScopeError):require_active_fixture(observation(URL.replace('filter','scroll-detail')),URL)
 def test_missing_uia_cannot_use_same_title(self):
  v=observation();v['result']['accessibility']={};v['result']['surfaces'][0]['title']='XHarness Shopping Load Lab'
  with self.assertRaises(FixtureScopeError):require_active_fixture(v,URL)
 def test_ambiguous_foreground(self):
  v=observation();v['result']['surfaces'][1]['frontmost']=True
  with self.assertRaises(FixtureScopeError):require_active_fixture(v,URL)
 def test_ambiguous_address(self):
  v=observation();v['result']['accessibility']['nodes']*=2
  with self.assertRaises(FixtureScopeError):require_active_fixture(v,URL)
 def test_outcome_unknown_never_admits(self):
  v=observation();v['ok']=False
  with self.assertRaises(FixtureScopeError):require_active_fixture(v,URL)
 def test_credentials_fragment_and_bad_port_rejected(self):
  for bad in [URL+'#product-779',URL.replace('10.0.2.2','user:secret@10.0.2.2'),URL.replace(':18106',':bad')]:
   with self.subTest(value=bad),self.assertRaises(FixtureScopeError):require_active_fixture(observation(bad),URL)
if __name__=='__main__':unittest.main()
