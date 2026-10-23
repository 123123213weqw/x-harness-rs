"""Keep browser CI image/lock versions aligned, runnable and fail closed."""
import json
from pathlib import Path
import re
import unittest
ROOT=Path(__file__).resolve().parents[1]
IMAGE='mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48'
def job(path,name):
 s=(ROOT/path).read_text()
 return re.search(r'(?ms)^  '+re.escape(name)+r':\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)',s).group(1)
def validate(body,version):
 image=re.search(r'(?m)^      image: (.+)$',body)
 assert image and image.group(1)==IMAGE,'browser image must retain its reviewed digest'
 assert ':v'+version+'-noble@sha256:' in image.group(1),'browser image and dependency lock must agree'
 assert 'PLAYWRIGHT_BROWSERS_PATH: /ms-playwright' in body
 assert 'node scripts/ci/check-browser-image.mjs' in body,'real launch validation cannot be skipped'
 assert 'install --with-deps' not in body and 'apt-get' not in body,'browser shards must not redownload OS dependencies'
 assert 'continue-on-error' not in body,'incomplete browser evidence cannot pass'
class BrowserRuntimeTests(unittest.TestCase):
 def test_all_browser_jobs_use_locked_baked_runtime(self):
  version=json.loads((ROOT/'scripts/ui-test-deps/package-lock.json').read_text())['packages']['node_modules/playwright']['version']
  self.assertEqual(version,json.loads((ROOT/'plugins/browser-use/package-lock.json').read_text())['packages']['node_modules/playwright']['version'])
  for path,name in [('.github/workflows/ci.yml','ui-browser'),('.github/workflows/ci.yml','ui-parity'),('.github/workflows/gui-bench-build.yml','browser-contract')]:
   with self.subTest(name=name):validate(job(path,name),version)
 def test_unreviewed_image_or_version_drift_is_rejected(self):
  body=job('.github/workflows/ci.yml','ui-browser')
  for changed,version in [(body.replace(IMAGE,'mcr.microsoft.com/playwright:latest'),'1.61.1'),(body,'9.9.9')]:
   with self.assertRaises(AssertionError):validate(changed,version)
 def test_missing_smoke_or_masked_failure_is_rejected(self):
  body=job('.github/workflows/ci.yml','ui-browser')
  for changed in [body.replace('node scripts/ci/check-browser-image.mjs','node ignored.mjs'),body+'\n        continue-on-error: true\n']:
   with self.assertRaises(AssertionError):validate(changed,'1.61.1')
 def test_original_suite_and_aggregate_gate_are_retained(self):
  body=job('.github/workflows/ci.yml','ui-browser');self.assertIn('timeout-minutes: 40',body)
  self.assertIn('scripts/ci-ui-suite.mjs --suite browser',body)
  self.assertIn('scripts/ci-ui-artifact.mjs --verify',body)
  self.assertIn('scripts/ci-ui-gate.mjs',job('.github/workflows/ci.yml','context-layout'))
if __name__=='__main__':unittest.main()
