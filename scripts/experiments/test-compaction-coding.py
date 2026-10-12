#!/usr/bin/env python3
"""Offline checks for evaluator shape. These are NOT model acceptance."""
import importlib.util, pathlib, subprocess, tempfile, unittest
P=pathlib.Path(__file__).with_name('compaction-coding.py')
S=importlib.util.spec_from_file_location('coding',P);m=importlib.util.module_from_spec(S);S.loader.exec_module(m)
class Evaluator(unittest.TestCase):
 def test_fixture_has_multiple_modules_and_readonly_acceptance(self):
  files, hidden=m.fixture(81)
  self.assertTrue({'parser.py','importer.py','report.py','tests/test_public.py','docs/api.txt','logs/legacy.log'} <= set(files))
  self.assertNotIn('test_hidden.py', files)
  self.assertIn('ROUND_HALF_UP', files['docs/api.txt'])
  self.assertIn('NFC', files['docs/api.txt'])
  self.assertIn('test_no_mutation',hidden)
 def test_seed_varies_evidence_not_api_or_acceptance(self):
  a,ha=m.fixture(81);b,hb=m.fixture(82)
  self.assertNotEqual(a['logs/legacy.log'],b['logs/legacy.log'])
  self.assertEqual(a['docs/api.txt'],b['docs/api.txt']);self.assertEqual(ha,hb)
 def test_original_source_is_red_under_independent_tests(self):
  files,hidden=m.fixture(81)
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);work=root/'work';tests=root/'acceptance';work.mkdir();tests.mkdir()
   for path,text in files.items():
    p=work/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
   (tests/'test_hidden.py').write_text(hidden)
   result=subprocess.run(['python3','-m','unittest','discover','-s',str(tests),'-v'],cwd=work,capture_output=True,text=True,timeout=20)
   self.assertNotEqual(result.returncode,0)
   self.assertIn('Ran 16 tests',result.stderr)
 def test_credential_not_in_subprocess_arguments_environment_or_audit(self):
  source=P.read_text()
  self.assertIn("proc.stdin.write(json.dumps({'api_key':key",source)
  self.assertNotIn("env[",source);self.assertNotIn('--api-key',source)
  self.assertIn('source fingerprint mismatch; no fixture or model request sent',source)
  bridge=P.parents[2]/'crates/xharness-host-app/examples/compaction_budget_eval.rs'
  text=bridge.read_text();self.assertIn('message.reasoning.clear()',text)
  self.assertIn('message.provider_items.clear()',text)
if __name__=='__main__':unittest.main()
