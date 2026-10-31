#!/usr/bin/env python3
import json,subprocess,tempfile,pathlib,argparse
from fixtures_targeted import cases
p=argparse.ArgumentParser();p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
rows=[]
for c in cases():
 with tempfile.TemporaryDirectory(prefix='xharness-coding-fixture-') as t:
  root=pathlib.Path(t)
  for name,text in c['files'].items():
   p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
  neg=subprocess.run(['python3','-c',c['hidden'][0]],cwd=root,capture_output=True,text=True,timeout=10);assert neg.returncode!=0
  for phase in [1,2,3]:
   for name,text in c['golden'][phase-1].items():(root/name).write_text(text)
   (root/'tests/test_public.py').write_text(c['public'][phase-1])
   hidden=subprocess.run(['python3','-c',c['hidden'][phase-1]],cwd=root,capture_output=True,text=True,timeout=10)
   assert hidden.returncode==0,(c['id'],phase,hidden.stdout,hidden.stderr)
   checks=json.loads(hidden.stdout)
   pub=subprocess.run(['python3','-m','unittest','discover','-s','tests'],cwd=root,capture_output=True,text=True,timeout=10)
   assert pub.returncode==0,(c['id'],phase,pub.stderr)
   rows.append({'case':c['id'],'phase':phase,'hidden_checks':checks['checks'],'all_passed':checks['passed']==checks['checks'],'negative_initial_failed':True,'doc_bytes':len(c['files']['docs/contract.txt'].encode())})
(a.output/'fixture-validation.json').write_text(json.dumps({'status':'passed','rows':rows},indent=2)+'\n');print(json.dumps({'status':'passed','cases':12,'phase_receipts':len(rows),'hidden_check_executions':sum(r['hidden_checks'] for r in rows)}))
