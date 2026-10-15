#!/usr/bin/env python3
"""Opt-in V100 coding/compaction acceptance; keychain -> SSH stdin only.
Runs the actual Rust LoopEngine, journal, history executor, archive and SummaryRunner.
No application state, deployment, private transcript or arbitrary shell tool is used.
"""
import argparse,hashlib,importlib.util,json,pathlib,shlex,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parents[2]

def fixture(seed):
 docs='''Ledger API v1 (authoritative current contract)
parse_amount(raw): accept a finite decimal string with whitespace/sign, convert to integer cents with ROUND_HALF_UP, no binary floating point; reject empty, non-numeric, NaN and Infinity with ValueError.
import_rows(rows): each input dict has id, timestamp (ISO8601), amount and optional revision (non-negative integer, default 0). Return new dicts id/day/cents/revision. Normalize id by strip and NFC, never lowercase. Reject an empty id, invalid timestamp and invalid revision. An aware timestamp is converted to UTC before taking its date; a naive timestamp denotes UTC. Z suffix is valid. Deduplicate by normalized id, keep the highest revision, at equal revision last input wins. Input must not be mutated; no module-global state between calls. Empty input returns [].
daily_totals(rows): call import_rows and aggregate cents per UTC day, returning a dict day -> integer cents. Honor deduplication. Empty input returns {}. Repeated calls are independent.
Only parser.py, importer.py and report.py may change. There is no publish or deployment task.
'''
 files={
 'parser.py':'def parse_amount(raw):\n    return int(float(raw) * 100)\n',
 'importer.py':'from parser import parse_amount\n\ndef import_rows(rows):\n    return [{"id":r["id"], "day":r["timestamp"][:10], "cents":parse_amount(r["amount"]), "revision":r.get("revision",0)} for r in rows]\n',
 'report.py':'from importer import import_rows\n\ndef daily_totals(rows):\n    result={}\n    for item in import_rows(rows):\n        result[item["day"]]=result.get(item["day"],0)+item["cents"]\n    return result\n',
 'docs/api.txt':docs,
 'logs/legacy.log': ''.join(f'worker={seed}-{i} status=healthy diagnostic={hashlib.sha256(f"{seed}-{i}".encode()).hexdigest()}\n' for i in range(900))+'\nNOTE: Prior deployment proposal is historical and has not been approved.\n',
 'tests/test_public.py':'''import unittest
from parser import parse_amount
from importer import import_rows
from report import daily_totals
class Public(unittest.TestCase):
 def test_money(self): self.assertEqual(parse_amount('1.005'),101)
 def test_negative_rounding(self): self.assertEqual(parse_amount('-0.005'),-1)
 def test_dedup(self): self.assertEqual(len(import_rows([dict(id='a',timestamp='2026-10-12',amount='1',revision=0),dict(id='a',timestamp='2026-10-12',amount='2',revision=1)])),1)
 def test_utc(self): self.assertEqual(daily_totals([dict(id='a',timestamp='2026-10-12T00:30:00+02:00',amount='2')]),{'2026-10-11':200})
'''}
 hidden='''import unittest, copy
from parser import parse_amount
from importer import import_rows
from report import daily_totals
class Hidden(unittest.TestCase):
 def row(self,id='a',time='2026-10-12T01:00:00Z',amount='1.00',revision=0):return dict(id=id,timestamp=time,amount=amount,revision=revision)
 def test_amounts(self):
  for raw,want in [('  2.675 ',268),('1.005',101),('-1.005',-101),('+0.004',0),('90071992547409.93',9007199254740993),('0',0)]:
   with self.subTest(raw=raw):self.assertEqual(parse_amount(raw),want)
 def test_invalid_amounts(self):
  for raw in ['', ' ', 'NaN', 'Infinity','-Infinity','abc']:
   with self.subTest(raw=raw),self.assertRaises(ValueError):parse_amount(raw)
 def test_dedup_highest(self):
  rows=[self.row(revision=9,amount='4'),self.row(revision=1,amount='7')]; self.assertEqual(import_rows(rows)[0]['cents'],400)
 def test_tied_last(self): self.assertEqual(import_rows([self.row(amount='3'),self.row(amount='8')])[0]['cents'],800)
 def test_unicode(self): self.assertEqual(len(import_rows([self.row(' e\\u0301 '),self.row('é')])),1)
 def test_case_sensitive(self): self.assertEqual(len(import_rows([self.row('A'),self.row('a')])),2)
 def test_utc_positive(self): self.assertEqual(import_rows([self.row(time='2026-10-12T00:20:00+05:30')])[0]['day'],'2026-10-11')
 def test_utc_negative(self): self.assertEqual(import_rows([self.row(time='2026-10-12T23:40:00-04:00')])[0]['day'],'2026-10-13')
 def test_naive(self): self.assertEqual(import_rows([self.row(time='2026-10-12T12:00:00')])[0]['day'],'2026-10-12')
 def test_invalid_id(self):
  with self.assertRaises(ValueError):import_rows([self.row('  ')])
 def test_invalid_time(self):
  with self.assertRaises(ValueError):import_rows([self.row(time='not-a-date')])
 def test_bad_revision(self):
  for r in [-1,1.5,'no']:
   with self.subTest(r=r),self.assertRaises(ValueError):import_rows([self.row(revision=r)])
 def test_empty(self):self.assertEqual(import_rows([]),[]); self.assertEqual(daily_totals([]),{})
 def test_no_mutation(self):
  rows=[self.row(' a ',amount='3',revision=2)];before=copy.deepcopy(rows);import_rows(rows);daily_totals(rows);self.assertEqual(rows,before)
 def test_no_shared_state(self):daily_totals([self.row()]);self.assertEqual(daily_totals([]),{})
 def test_aggregate(self):
  rows=[self.row('a',amount='1'),self.row('b',amount='2'),self.row('a',amount='4',revision=3)];self.assertEqual(daily_totals(rows),{'2026-10-12':600})
'''
 return files,hidden

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--host',default='WZU_Server');ap.add_argument('--control-path');ap.add_argument('--expected-compaction-sha');ap.add_argument('--binary',required=True);ap.add_argument('--remote-root',required=True);ap.add_argument('--output',type=pathlib.Path,required=True);ap.add_argument('--seed',type=int,default=81);ap.add_argument('--mode',choices=['coding','chunks'],default='coding');args=ap.parse_args()
 args.output.mkdir(parents=True,exist_ok=False)
 spec=importlib.util.spec_from_file_location('scope',ROOT/'scripts/eval-compact-task-scope.py');scope=importlib.util.module_from_spec(spec);spec.loader.exec_module(scope)
 key=scope.credential(pathlib.Path.home()/'Library/Application Support/com.xlang.xharness/state')
 ssh=['ssh','-T',*(['-S',args.control_path] if args.control_path else ['-o','ControlPath=none']),'-o','ControlMaster=no','-o','ForwardAgent=no','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=6',args.host]
 proc=subprocess.Popen([*ssh,shlex.quote(args.binary)+' '+shlex.quote(args.remote_root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(args.output/'stderr.log').open('w'),text=True,bufsize=1)
 proc.stdin.write(json.dumps({'api_key':key,'model':'deepseek-flash'})+'\n');proc.stdin.flush();del key
 ready=json.loads(proc.stdout.readline());(args.output/'ready.json').write_text(json.dumps(ready))
 if args.expected_compaction_sha and ready.get('compaction_source_sha256') != args.expected_compaction_sha:
  proc.stdin.close();proc.wait(timeout=20);raise RuntimeError('source fingerprint mismatch; no fixture or model request sent')
 replies=[]
 def call(command):
  ident=command['id'];(args.output/(ident+'-input.json')).write_text(json.dumps(command,ensure_ascii=False,indent=2))
  proc.stdin.write(json.dumps(command,ensure_ascii=False)+'\n');proc.stdin.flush()
  line=proc.stdout.readline()
  if not line:raise RuntimeError('evaluation process exited; see sanitized stderr')
  reply=json.loads(line);(args.output/(ident+'-reply.json')).write_text(json.dumps(reply,ensure_ascii=False,indent=2));replies.append(reply)
  result=reply.get('result',{});print(ident,json.dumps({k:result[k] for k in ('ok','status','error','calls','splits','failed_tests') if k in result}),flush=True)
  return result
 try:
  if args.mode=='coding':
   files,hidden=fixture(args.seed);call({'id':'fixture','op':'install_fixture','files':files})
   call({'id':'partial','op':'turn','context':32768,'user':'Read docs/api.txt and logs/legacy.log, inspect the three source modules, and run test once on the original code. First implement ONLY parse_amount in parser.py according to the API; then run the public tests and stop, reporting the remaining importer/report failures. Do not fix those other modules yet. Use the history tool if a read result is truncated.'})
   call({'id':'checkpoint','op':'maintenance','context':32768})
   call({'id':'finish','op':'turn','context':32768,'user':'Now finish importer.py and report.py according to the same API, preserving the corrected parser. Read their CURRENT files before writing; historical test results are not proof. Run the public tests after your edits and fix failures. No deployment, no publish; only the three source modules. Complete the implementation, not just a proposal.'})
   # The independent evaluator is outside the model-editable/readable workspace.
   remote=args.remote_root+'/acceptance';payload=json.dumps({'test_hidden.py':hidden})
   install="import json,pathlib,sys;p=pathlib.Path(sys.argv[1]);p.mkdir();[(p/k).write_text(v) for k,v in json.load(sys.stdin).items()]"
   subprocess.run([*ssh,'python3 -c '+shlex.quote(install)+' '+shlex.quote(remote)],input=payload,text=True,check=True)
   test=subprocess.run([*ssh,'cd '+shlex.quote(args.remote_root+'/work')+' && PYTHONPATH=. timeout 30 python3 -m unittest discover -s '+shlex.quote(remote)+' -v'],capture_output=True,text=True)
   (args.output/'acceptance.txt').write_text(test.stdout+test.stderr);(args.output/'acceptance.json').write_text(json.dumps({'exit_code':test.returncode,'passed':test.returncode==0}));print('ACCEPTANCE',test.returncode,flush=True)
  else:
   def msg(text):return {'role':'user','content':text,'reasoning':''}
   # Same actual runner; configured SMALL evaluation windows, not provider maxima.
   noise=''.join(f'read log line {i:04d}: subsystem=csv code=healthy event=K{i:04d}\n' for i in range(1400))
   source=[msg('User requested only the ledger fix; no publish. ' +noise),msg('Latest correction: timezone must be UTC; keep NFC identifiers case-sensitive and highest revision. Exact rounding ROUND_HALF_UP. Current failing test test_utc; files importer.py/report.py.')]+[msg('Read-only observation '+str(i)) for i in range(6)]
   call({'id':'skewed','op':'compact','context':32768,'output':1024,'messages':source})
   call({'id':'unicode','op':'compact','context':8192,'output':1024,'messages':[msg(('金额按半入舍入；时区 UTC；标识不改大小写🙂\n'*750)+' Exact final marker END-81')]})
  call({'id':'metrics','op':'metrics'})
 finally:
  proc.stdin.close();proc.wait(timeout=40)
  subprocess.run(['rsync','-az','--timeout=90','-e','ssh -o ControlMaster=no '+ ('-S '+shlex.quote(args.control_path) if args.control_path else '-o ControlPath=none') +' -o BatchMode=yes -o ForwardAgent=no -o ConnectTimeout=15',args.host+':'+args.remote_root+'/',str(args.output/'remote')+'/'],check=True)
  (args.output/'provenance.json').write_text(json.dumps({'mode':args.mode,'seed':args.seed,'remote_binary':args.binary,'root':args.remote_root,'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'scope':'actual core loop + production compaction; isolated bounded read/write and fixed Python test handlers, not desktop/native bash E2E'},indent=2))
if __name__=='__main__':main()
