#!/usr/bin/env python3
"""Finalize only complete paired discovery + independent-seed replication."""
import argparse,collections,hashlib,json,shutil,subprocess,sys,time
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--root',required=True,type=Path);a=p.parse_args();root=a.root
combined=root/'combined';(combined/'results').mkdir(parents=True,exist_ok=True)
all_cases=[];ids=set();response_ids=set();requests=[];history=collections.Counter();phases={}
for phase in ['matrix','holdout']:
    d=root/phase;cs=json.loads((d/'cases.json').read_text());protocol=json.loads((d/'protocol.json').read_text());ps=list((d/'results').glob('*.json'))
    assert len(cs)==24 and len(ps)==168,(phase,'not complete')
    assert not ids.intersection(c['id'] for c in cs),'replication case IDs overlap'
    ids.update(c['id'] for c in cs);all_cases.extend(cs)
    expected={(c['id'],v) for c in cs for v in protocol['variants']};seen=set()
    for f in ps:
        r=json.loads(f.read_text());seen.add((r['case'],r['variant']));shutil.copy2(f,combined/'results'/f.name)
        trace=[json.loads(l) for l in (d/'traces'/(f.stem+'.jsonl')).open()]
        gs=[x for x in trace if x['type']=='generation'];ts=[x for x in trace if x['type']=='tool']
        assert len(gs)==sum(bool(x.get('id')) for x in r['requests'])
        assert len(ts)==len(r['history_calls'])
        assert r['prompt_tokens']==sum(x['usage']['prompt_tokens'] for x in gs)
        assert r['completion_tokens']==sum(x['usage']['completion_tokens'] for x in gs)
        for x in gs:
            assert x['model']=='deepseek-flash';assert x['id'] not in response_ids
            response_ids.add(x['id']);requests.append(x)
        for t in ts:
            name=t['call'].get('function',{}).get('name')
            try:op=json.loads(t['call']['function']['arguments']).get('action')
            except (ValueError,TypeError):op='invalid_json'
            history[f'{name}:{op}']+=1
    assert seen==expected,(phase,'unpaired trials')
    phases[phase]={'cases':len(cs),'trials':len(ps),'protocol_sha256':hashlib.sha256((d/'protocol.json').read_bytes()).hexdigest(),'cases_sha256':hashlib.sha256((d/'cases.json').read_bytes()).hexdigest()}
(combined/'cases.json').write_text(json.dumps(all_cases,indent=2)+'\n')
subprocess.run([sys.executable,str(Path(__file__).with_name('analyze.py')),'--output',str(combined)],stdout=(root/'combined-analysis.log').open('w'),check=True)
analysis=json.loads((combined/'analysis.json').read_text());groups=analysis['groups'];full=groups['full'];current=groups['current']
for name,g in groups.items():
    g['prompt_reduction_vs_full']=1-g['mean_total_prompt_tokens']/full['mean_total_prompt_tokens']
    g['prompt_reduction_vs_current']=1-g['mean_total_prompt_tokens']/current['mean_total_prompt_tokens']
    g['regular_prompt_reduction_vs_full']=1-g['mean_regular_prompt_tokens']/full['mean_regular_prompt_tokens']
    g['regular_prompt_reduction_vs_current']=1-g['mean_regular_prompt_tokens']/current['mean_regular_prompt_tokens']
(combined/'analysis.json').write_text(json.dumps(analysis,indent=2)+'\n')
receipt={'status':'complete','completed_at':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'phases':phases,'paired_cases':48,'trials':336,'model':'deepseek-flash','thinking':'enabled/high','unique_successful_api_responses':len(requests),'actual_prompt_tokens_including_rereads':sum(x['usage']['prompt_tokens'] for x in requests),'actual_completion_tokens':sum(x['usage']['completion_tokens'] for x in requests),'history_attempts':dict(history),'groups':groups,
'limitations':['48 synthetic matched tasks in eight families, not a production user success rate.','Same task templates with independent factual seeds; cases are not independent draws from arbitrary production workloads.','Primary strict-object score frozen before discovery; secondary content audit introduced before replication, original scores untouched.','Production pruner and history executor; experimental typed extractor and Python provider loop, not full LoopEngine.','History queries inspect a frozen synthetic original prefix; generated model/read replies are replayed in the API conversation but not appended into its evidence store.','No semantic-summary compaction, working-set retirement, images, desktop shell or actual production side effects tested.','Input tokens are upstream returned usage, not estimated counts or dollar charges.','No production policy/configuration change, merge or release.']}
(root/'completion-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='groups'},indent=2));print(json.dumps({k:{field:g[field] for field in ['n','strict_contract_successes','required_fields_successes','nested_evidence_successes','mean_total_prompt_tokens','mean_regular_prompt_tokens','history_calls','history_errors','provider_failures']} for k,g in groups.items()},indent=2))
