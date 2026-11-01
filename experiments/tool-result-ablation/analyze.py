#!/usr/bin/env python3
"""Secondary, uniform content-vs-contract audit. Does not rewrite trial scores.

The frozen primary exact-object score remains intact. Required-field scoring
ignores extra keys, but never ignores an incorrect/missing requested field.
Nested field recovery is reported separately, not silently scored as flat JSON.
"""
import argparse,json,math,statistics
from pathlib import Path
from run import wilson

p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();root=a.output
cs={c['id']:c for c in json.loads((root/'cases.json').read_text())}
rs=[json.loads(f.read_text()) for f in sorted((root/'results').glob('*.json'))]

def same(a,b):
    if type(a) is not type(b):return False
    if isinstance(a,dict):return a.keys()==b.keys() and all(same(a[k],b[k]) for k in a)
    if isinstance(a,list):return len(a)==len(b) and all(same(x,y) for x,y in zip(a,b))
    return a==b

def leaves(v,key):
    found=[]
    if isinstance(v,dict):
        for k,x in v.items():
            if k==key:found.append(x)
            elif isinstance(x,(dict,list)):found.extend(leaves(x,key))
    elif isinstance(v,list):
        for x in v:found.extend(leaves(x,key))
    return found

def content(r):
    if cs[r['case']]['family']=='code_patch':return bool(r['score']['success']),bool(r['score']['success'])
    v=r['score'].get('actual');gold=cs[r['case']]['golden']
    if not isinstance(v,dict):return False,False
    required=all(k in v and same(v[k],expected) for k,expected in gold.items())
    nested=True
    for k,expected in gold.items():
        if k in v:ok=same(v[k],expected)
        else:
            xs=leaves(v,k);ok=bool(xs) and all(same(x,expected) for x in xs)
        nested=nested and ok
    return required,nested

for r in rs:
    r['required_fields_correct'],r['nested_evidence_correct']=content(r)

groups={}
base={r['case']:r for r in rs if r['variant']=='full'}
for variant in sorted({r['variant'] for r in rs}):
    xs=[r for r in rs if r['variant']==variant];n=len(xs)
    prompts=[r['prompt_tokens'] for r in xs];latency=sorted(r['elapsed_s'] for r in xs)
    strict=sum(r['score']['success'] for r in xs);required=sum(r['required_fields_correct'] for r in xs);nested=sum(r['nested_evidence_correct'] for r in xs)
    pairs=[(r,base[r['case']]) for r in xs if r['case'] in base]
    groups[variant]={'n':n,'strict_contract_successes':strict,'required_fields_successes':required,'nested_evidence_successes':nested,
        'strict_rate':strict/n,'content_rate':required/n,'content_wilson95':wilson(required,n),
        'mean_total_prompt_tokens':sum(prompts)/n,'mean_total_completion_tokens':sum(r['completion_tokens'] for r in xs)/n,
        'mean_initial_tool_chars':sum(r['initial_tool_chars'] for r in xs)/n,'mean_latency_s':sum(latency)/n,'p95_latency_s':latency[max(0,math.ceil(n*.95)-1)],
        'median_total_prompt_tokens':statistics.median(prompts),
        'mean_regular_prompt_tokens':statistics.mean(r['prompt_tokens'] for r in xs if r['family']!='paged_search') if any(r['family']!='paged_search' for r in xs) else None,
        'mean_paged_stress_prompt_tokens':statistics.mean(r['prompt_tokens'] for r in xs if r['family']=='paged_search') if any(r['family']=='paged_search' for r in xs) else None,
        'total_generations':sum(r['generation_calls'] for r in xs),'history_calls':sum(len(r['history_calls']) for r in xs),'history_errors':sum(sum(not h['ok'] for h in r['history_calls']) for r in xs),
        'provider_failures':sum(r['outcome']=='provider_failure' for r in xs),
        'paired_content_regressions':sum(b['required_fields_correct'] and not r['required_fields_correct'] for r,b in pairs),
        'paired_content_improvements':sum(r['required_fields_correct'] and not b['required_fields_correct'] for r,b in pairs),
        'failures':[{'case':r['case'],'reason':r['score']['reason'],'outcome':r['outcome'],'strict':r['score']['success'],'required_fields':r['required_fields_correct'],'nested_evidence':r['nested_evidence_correct']} for r in xs if not r['score']['success']],
        'families':{fam:{'n':len(zs),'required_fields':sum(z['required_fields_correct'] for z in zs),'strict':sum(z['score']['success'] for z in zs)} for fam in sorted({r['family'] for r in xs}) if (zs:=[r for r in xs if r['family']==fam])}}
report={'completed':len(rs),'primary_metric':'Frozen exact JSON object / executable code tests, unchanged','secondary_metric':'Requested top-level fields correct, strict JSON types; extra fields ignored uniformly','diagnostic_only':'Nested evidence can be correct while the requested output contract is violated','groups':groups}
(root/'analysis.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
