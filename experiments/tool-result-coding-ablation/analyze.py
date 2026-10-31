#!/usr/bin/env python3
"""Audit objective multi-turn results without changing the frozen trial scores."""
import argparse,collections,hashlib,json,math,statistics
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);p.add_argument('--require-complete',action='store_true');a=p.parse_args();out=a.output
cs={c['id']:c for c in json.loads((out/'cases.json').read_text())};protocol=json.loads((out/'protocol.json').read_text());rows=[json.loads(f.read_text()) for f in sorted((out/'results').glob('*.json'))]
expected={(c,s) for c in cs for s in protocol['strategies']};actual={(r['case'],r['strategy']) for r in rows}
assert len(actual)==len(rows)
if a.require_complete:assert actual==expected,{'missing':sorted(expected-actual)}

def count_input(u):return sum(u.get(k,0) for k in ['input_tokens','cache_read_tokens','cache_write_tokens'])
def cost(r):return sum(count_input(x.get('usage') or {}) for x in r.get('metrics',{}).get('provider',[]) if x.get('status')=='completed')
def subtotal(xs):
 n=len(xs);success=sum(r['all_verified'] for r in xs);healthy=[r for r in xs if r['all_verified']]
 return {'n':n,'all_stages_verified':success,'all_stages_code_correct':sum(r['all_code_correct'] for r in xs),'final_code_correct':sum(r.get('phases',[{}])[-1].get('code_correct',False) for r in xs),
 'total_input_tokens':sum(cost(r) for r in xs),'mean_input_tokens':statistics.mean(cost(r) for r in xs) if xs else None,'mean_input_successful_sessions':statistics.mean(cost(r) for r in healthy) if healthy else None,'tokens_per_verified_success_including_failures':sum(cost(r) for r in xs)/success if success else None,
 'mean_latency_s':statistics.mean(r['elapsed_s'] for r in xs) if xs else None,'mean_latency_successful_s':statistics.mean(r['elapsed_s'] for r in healthy) if healthy else None,
 'injected_history_errors':sum(r.get('metrics',{}).get('injected_history_failures',0) for r in xs)}

groups={};failures=[];all_provider=[];all_history=collections.Counter();all_faults=0;proof_violations=[]
for r in rows:
 assert r['all_code_correct']==(len(r['phases'])==3 and all(x['code_correct'] for x in r['phases']))
 assert r['all_verified']==(len(r['phases'])==3 and all(x['verified_success'] for x in r['phases']))
 for x in r['phases']:
  h=x['hidden'];assert x['code_correct']==(h is not None and h['passed']==h['checks'] and x['evaluation']['execution']['exit_code']==0)
  assert x['verified_success']==(x['code_correct'] and x['engine_completed'] and x['fresh_public_test_proof'])
  if x['code_correct'] and not x['verified_success']:proof_violations.append({'case':r['case'],'strategy':r['strategy'],'phase':x['phase'],'engine_completed':x['engine_completed'],'fresh_public_test_proof':x['fresh_public_test_proof']})
  for call in x['turn'].get('calls',[]):
   if call['name']=='history':
    args=call.get('arguments') or {};all_history[str(args.get('action'))+':'+('ok' if call['ok'] else 'error')]+=1
  if not x['verified_success']:
   expr={line.split('check("',1)[1].split('"',1)[0]:line.split('lambda: ',1)[1][:-1] for line in cs[r['case']]['hidden'][x['phase']-1].splitlines() if line.startswith('check("')}
   failures.append({'case':r['case'],'strategy':r['strategy'],'fault':r['fault'],'phase':x['phase'],'engine_status':x['turn'].get('status'),'engine_error':x['turn'].get('error'),'code_correct':x['code_correct'],'fresh_public_test_proof':x['fresh_public_test_proof'],'failed_assertions':[{'label':f['label'],'category':f['category'],'expression':expr.get(f['label'])} for f in (h or {}).get('failures',[])]})
 all_provider.extend(r.get('metrics',{}).get('provider',[]));all_faults+=r.get('metrics',{}).get('injected_history_failures',0)
for s in protocol['strategies']:
 xs=[r for r in rows if r['strategy']==s]
 if not xs:continue
 baseline={r['case']:r for r in rows if r['strategy']=='full'}
 pairs=[(r,baseline[r['case']]) for r in xs if r['case'] in baseline]
 goodpairs=[(r,b) for r,b in pairs if r['all_verified'] and b['all_verified']]
 g=subtotal(xs);g['by_fault']={f:subtotal([r for r in xs if r['fault']==f]) for f in ['normal','transient','outage']}
 g['paired_regressions_vs_full']=[r['case'] for r,b in pairs if b['all_verified'] and not r['all_verified']];g['paired_improvements_vs_full']=[r['case'] for r,b in pairs if r['all_verified'] and not b['all_verified']]
 g['paired_success_cost']={'n':len(goodpairs),'input_reduction_vs_full':1-sum(cost(r) for r,b in goodpairs)/sum(cost(b) for r,b in goodpairs) if goodpairs else None}
 g['history_calls']=sum(sum(t['name']=='history' for t in x['turn'].get('calls',[])) for r in xs for x in r['phases'])
 g['history_errors']=sum(sum(t['name']=='history' and not t['ok'] for t in x['turn'].get('calls',[])) for r in xs for x in r['phases'])
 g['fallback_policy_invocations']=sum(sum(v['fallback_full'] for v in r.get('metrics',{}).get('projection',[])) for r in xs)
 groups[s]=g
completed=[x for x in all_provider if x.get('status')=='completed'];max_input=max([count_input(x.get('usage') or {}) for x in completed] or [0])
report={'status':'complete' if actual==expected else 'partial','sessions':len(rows),'expected_sessions':len(expected),'phase_evaluations':sum(len(r['phases']) for r in rows),'hidden_assertion_executions':sum((x['hidden'] or {}).get('checks',0) for r in rows for x in r['phases']),'completed_real_provider_streams':len(completed),'provider_errors_or_pending':collections.Counter(x.get('status') for x in all_provider if x.get('status')!='completed'),'actual_input_tokens':sum(count_input(x.get('usage') or {}) for x in completed),'actual_output_tokens_including_reasoning':sum(sum((x.get('usage') or {}).get(k,0) for k in ['output_tokens','reasoning_tokens']) for x in completed),'largest_actual_request_input':max_input,'all_completed_requests_within_configured_context':max_input+16384+4096<=1048576,'history_calls':dict(all_history),'injected_history_errors':all_faults,'groups':groups,'failures':failures,'code_correct_but_not_verified':proof_violations,'limitations':['Generated projects and small matched case set, not production success probability.','Normal, transient and persistent outage are experimental strata, not measured field incidence.','Real LoopEngine/provider/JSONL journal/history/executor; compact and working-set retirement disabled.','The pressure arm uses an explicit experimental UTF-8-byte soft trigger, not a native admission-token limit.','Fallback restores already-visible original bodies within the same allowed source surface; not an authorization bypass or resurrection of retired inaccessible history.','Tokens for failed runs remain in cost totals; success-only paired cost also reported.','Native usage is normalized by the existing production adapter. No estimate-based dollar claims.']}
(out/'analysis.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['failures','groups']},indent=2));print(json.dumps(groups,indent=2))
