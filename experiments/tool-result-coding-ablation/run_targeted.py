#!/usr/bin/env python3
"""Remote-only real LoopEngine coding sessions; synthetic projects, actual tests."""
from __future__ import annotations
import argparse,concurrent.futures,hashlib,json,os,random,select,shlex,subprocess,sys,time,uuid
from pathlib import Path
from fixtures_targeted import cases
STRATEGIES=['full','typed_targeted']
REPO=Path(__file__).resolve().parents[2]
SOURCE=REPO/'crates/xharness-host-app/examples/tool_result_coding_targeted.rs'

def dump(x):return json.dumps(x,separators=(',',':'),ensure_ascii=False)
def sha(x):return hashlib.sha256(x).hexdigest()

def summary(out):
 rows=[json.loads(p.read_text()) for p in (out/'results').glob('*.json')]
 groups={}
 for s in STRATEGIES:
  rs=[r for r in rows if r['strategy']==s]
  if not rs:continue
  n=len(rs);phases=[p for r in rs for p in r.get('phases',[])]
  usage=[x.get('usage') or {} for r in rs for x in r.get('metrics',{}).get('provider',[]) if x.get('status')=='completed']
  inp=sum(u.get('input_tokens',0)+u.get('cache_read_tokens',0)+u.get('cache_write_tokens',0) for u in usage)
  groups[s]={'sessions':n,'all_stages_code_correct':sum(r['all_code_correct'] for r in rs),'all_stages_verified':sum(r['all_verified'] for r in rs),'final_code_correct':sum(r.get('phases',[{}])[-1].get('code_correct',False) for r in rs),
             'phase_count':len(phases),'phases_code_correct':sum(p['code_correct'] for p in phases),'phases_verified':sum(p['verified_success'] for p in phases),'total_input_tokens':inp,'mean_session_input_tokens':inp/n,'completed_api_calls':len(usage),
             'mean_session_latency_s':sum(r['elapsed_s'] for r in rs)/n,'injected_history_failures':sum(r.get('metrics',{}).get('injected_history_failures',0) for r in rs),'tool_failures':sum(sum(not t['ok'] for t in p.get('turn',{}).get('calls',[])) for p in phases),
             'by_fault':{f:{'sessions':len(xs),'all_code_correct':sum(x['all_code_correct'] for x in xs),'all_verified':sum(x['all_verified'] for x in xs)} for f in ['normal','transient','outage'] if (xs:=[r for r in rs if r['fault']==f])},
             'setup_or_transport_failures':sum(bool(r.get('failure')) for r in rs)}
 report={'completed_sessions':len(rows),'groups':groups,'scope':'Production LoopEngine/OpenAI adapter/JSONL journal/history/executor; generated isolated Python projects, actual code execution, not a production workload success rate. Compaction disabled to isolate tool-body projection.'}
 (out/'summary.json').write_text(json.dumps(report,indent=2)+'\n');return report

class Remote:
 def __init__(self,out,trial,strategy,fault,key,model,tag):
  self.stderr=(out/'traces'/(trial+'.stderr')).open('w')
  self.root='.regression-artifacts/tool-result-coding-20261031/'+tag+'/'+trial+'-'+uuid.uuid4().hex[:8]
  cmd='cd ~/codex-build/x-harness-rs && target/debug/examples/tool_result_coding_targeted '+shlex.quote(self.root)
  self.p=subprocess.Popen(['ssh','-T','-o','BatchMode=yes','-o','ForwardAgent=no','-o','ConnectTimeout=15','WZU_Server',cmd],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.stderr,text=True,bufsize=1)
  self.p.stdin.write(dump({'api_key':key,'model':model,'strategy':strategy,'fault':fault})+'\n');self.p.stdin.flush()
  self.ready=self.read(90)
  if not self.ready.get('ready'):raise RuntimeError('remote initialization failed')
  if self.ready.get('runtime_source_sha256')!=sha(SOURCE.read_bytes()):raise RuntimeError('compiled source differs from frozen local source')
 def read(self,timeout):
  readable,_,_=select.select([self.p.stdout],[],[],timeout)
  if not readable:raise TimeoutError('remote response bound exceeded')
  line=self.p.stdout.readline()
  if not line:raise RuntimeError('remote process ended before response')
  return json.loads(line)
 def call(self,op,**fields):
  self.p.stdin.write(dump({'op':op,'id':uuid.uuid4().hex,**fields})+'\n');self.p.stdin.flush()
  return self.read(1050)['result']
 def close(self):
  try:self.p.stdin.close()
  except BrokenPipeError:pass
  try:self.p.wait(timeout=30)
  except subprocess.TimeoutExpired:self.p.terminate();self.p.wait(timeout=10)
  self.stderr.close()

def run_trial(c,s,args,key):
 trial=c['id']+'--'+s;begun=time.monotonic();remote=None
 row={'case':c['id'],'family':c['family'],'fault':c['fault'],'strategy':s,'phases':[],'all_code_correct':False,'all_verified':False}
 trace=args.output/'traces'/(trial+'.jsonl')
 try:
  remote=Remote(args.output,trial,s,c['fault'],key,args.model,args.tag);row['remote_root']=remote.root
  with trace.open('w') as f:
   f.write(dump({'type':'ready','value':remote.ready})+'\n');f.flush()
   remote.call('install',files=c['files'])
   for phase in [1,2,3]:
    if phase==2:remote.call('retire_contract')
    if phase>1:remote.call('install',files={'tests/test_public.py':c['public'][phase-1]})
    t=time.monotonic();turn=remote.call('turn',phase=phase,user=c['users'][phase-1]);f.write(dump({'type':'turn','phase':phase,'value':turn})+'\n');f.flush()
    evaluated=remote.call('evaluate',script=c['hidden'][phase-1]);execution=evaluated['execution'];details=None
    for line in execution['stdout'].splitlines():
     try:
      v=json.loads(line)
      if isinstance(v,dict) and 'checks' in v and 'passed' in v:details=v
     except ValueError:pass
    code_ok=execution['exit_code']==0 and details is not None and details['checks']==details['passed']
    source=execution['source_sha256'];proof=False
    for call in turn.get('calls',[]):
     if call['name']=='test' and call['ok']:
      try:r=json.loads(call['result'])
      except ValueError:continue
      if r.get('status')=='passed' and r.get('source_sha256')==source:proof=True
    complete=turn.get('status')=='completed' and turn.get('error') is None
    item={'phase':phase,'code_correct':code_ok,'engine_completed':complete,'fresh_public_test_proof':proof,'verified_success':code_ok and proof and complete,'elapsed_s':round(time.monotonic()-t,3),'hidden':details,'evaluation':evaluated,'turn':turn}
    row['phases'].append(item);f.write(dump({'type':'evaluation','phase':phase,'value':evaluated})+'\n');f.flush()
    print(dump({'trial':trial,'phase':phase,'code_correct':code_ok,'verified':item['verified_success'],'status':turn.get('status'),'tools':len(turn.get('calls',[]))}),flush=True)
   row['metrics']=remote.call('metrics')
   row['all_code_correct']=all(p['code_correct'] for p in row['phases'])
   row['all_verified']=all(p['verified_success'] for p in row['phases'])
 except Exception as e:
  row['failure']={'category':type(e).__name__,'scope':'setup_or_orchestrator_transport'}
 finally:
  if remote:remote.close()
 row['elapsed_s']=round(time.monotonic()-begun,3)
 (args.output/'results'/(trial+'.json')).write_text(json.dumps(row,indent=2)+'\n')
 print(dump({'trial':trial,'complete':True,'all_code_correct':row['all_code_correct'],'all_verified':row['all_verified'],'elapsed_s':row['elapsed_s'],'failure':row.get('failure')}),flush=True)
 return row

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',required=True,type=Path);p.add_argument('--strategies',default=','.join(STRATEGIES));p.add_argument('--cases',default='');p.add_argument('--workers',type=int,default=4);p.add_argument('--prepare-only',action='store_true');p.add_argument('--summarize-only',action='store_true');p.add_argument('--model',default='deepseek-flash');p.add_argument('--tag',default='matrix');a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
 for d in ['results','traces']:(a.output/d).mkdir(exist_ok=True)
 if a.summarize_only:print(dump(summary(a.output)));return
 cs=cases()
 if a.cases:cs=[c for c in cs if c['id'] in a.cases.split(',')]
 text=json.dumps(cs,indent=2)+'\n';cp=a.output/'cases.json'
 if cp.exists() and cp.read_text()!=text:raise RuntimeError('cases changed; new directory required')
 cp.write_text(text)
 protocol={'version':1,'workers':a.workers,'model':a.model,'thinking':'enabled/high','temperature':0.2,'strategies':a.strategies.split(','),'cases_sha256':sha(text.encode()),'rust_sha256':sha(SOURCE.read_bytes()),'runner_sha256':sha(Path(__file__).read_bytes()),'fixtures_sha256':sha(Path(__file__).with_name('fixtures_targeted.py').read_bytes()),'primary':'all 3 stages actual hidden tests correct AND engine completed AND actual public tests passed for final source hash','secondary':'code-correct per stage and final stage, independent of answer format','pressure_threshold':'experimental 65536 UTF-8 message content bytes, not native admission tokens','history_failure_fallback':'typed_targeted uses pressure+fresh pin and bounded session-backend evidence (12 KiB), never global body promotion','faults':'normal, once-only transient from stage2, persistent service outage from stage2; originals remain in journal','max_steps_per_turn':32,'turn_deadline_s':900,'output_reserve':16384,'hard_context':1048576,'compaction':False,'timestamp':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'tag':a.tag}
 pp=a.output/'protocol.json'
 if pp.exists():
  old=json.loads(pp.read_text())
  for k in ['model','strategies','cases_sha256','rust_sha256','runner_sha256','fixtures_sha256']:
   if old[k]!=protocol[k]:raise RuntimeError('frozen protocol changed: '+k)
 else:pp.write_text(json.dumps(protocol,indent=2)+'\n')
 if a.prepare_only:print(dump(protocol));return
 key=(Path.home()/'Library/Application Support/XHarness/secrets/deepseek_api_key').read_text().strip()
 tasks=[(c,s) for c in cs for s in a.strategies.split(',') if not (a.output/'results'/(c['id']+'--'+s+'.json')).exists()];random.Random(311099).shuffle(tasks)
 with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
  fs=[pool.submit(run_trial,c,s,a,key) for c,s in tasks]
  for f in concurrent.futures.as_completed(fs):f.result();summary(a.output)
 print(dump(summary(a.output)))

if __name__=='__main__':main()
