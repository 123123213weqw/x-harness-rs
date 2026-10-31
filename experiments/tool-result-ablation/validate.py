#!/usr/bin/env python3
"""Offline positive/negative controls for the ablation bridge and scorer."""
import argparse, hashlib, json, re
from pathlib import Path
from run import Bridge, cases, dump, grade, projection

p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);args=p.parse_args()
args.output.mkdir(parents=True,exist_ok=True)
bridge=Bridge('WZU_Server','~/codex-build/x-harness-rs/target/debug/examples/tool_result_ablation_bridge',args.output)
checks=[]
try:
    for c in cases([0,1,2]):
        init=bridge.call({'op':'init','session':c['id'],'task':c['task'],'fresh':c['fresh'],'results':c['results']})
        a=init['surfaces']
        def tool_texts(surface):return [m['content'] for m in surface if m['role']=='tool']
        for actual,full,pruned in zip(tool_texts(a['current']),tool_texts(a['full']),tool_texts(a['all8k'])):
            assert actual==(full if c['fresh'] and len(full.encode())<=256*1024 else pruned)
        assert sum(map(len,tool_texts(a['all2k']))) < sum(map(len,tool_texts(a['all8k'])))
        for v in ['full','current','all8k','all2k','typed2k','archive_only','typed2k_nohistory']:
            ms=projection(c,init,v);pending={}
            for m in ms:
                for t in m.get('tool_calls',[]):pending[t['id']]=t
                if m['role']=='tool':assert pending.pop(m['tool_call_id'],None)
            assert not pending
        for i,r in enumerate(c['results']):
            assert hashlib.sha256(r['content'].encode()).hexdigest()==init['archives'][i]['sha256']
        if c['family']=='code_patch':
            text=json.loads(c['results'][0]['content'])['text'];fee=int(re.search(r'plus (\d+) ONLY',text)[1]);cutoff=int(re.search(r'n>(\d+)',text)[1])
            good=f'0 if n <= 0 else (n+batch-1)//batch + ({fee} if n>{cutoff} else 0)'
            assert grade(c,dump({'expression':good}))['success']
            assert not grade(c,dump({'expression':'n//batch'}))['success']
            assert not grade(c,dump({'expression':"__import__('os').system('true')"}))['success']
        else:
            assert grade(c,dump(c['golden']))['success']
            assert not grade(c,'{}')['success']
        checks.append({'case':c['id'],'current_policy_freshness_parity':True,'archive_sha256':True,'tool_pairs_intact':True,'scorer_positive_negative':True})
    # Exact full archive reconstruction through the real 2048-byte page limiter.
    c=cases([0])[0];key=hashlib.sha256(c['results'][0]['content'].encode()).hexdigest();offset=0;chunks=[]
    while True:
        res=bridge.call({'op':'history','session':c['id'],'arguments':{'action':'read','archive':key,'offset':offset,'limit':2048}})
        assert res['failure'] is None;value=json.loads(res['output']['content']);assert len(dump(value).encode())<=4096
        chunks.append(value['text'])
        if value['complete']:break
        offset=value['next_offset']
    assert ''.join(chunks)==c['results'][0]['content']
    history_checks={'archive_reconstruction_bytes':len(''.join(chunks).encode()),'pages':len(chunks)}
    # Search crosses both the four-hit and 256-KiB scan limits.
    args_search={'action':'search','query':'TARGET_ROUTE'};pages=0;hits=[]
    while True:
        res=bridge.call({'op':'history','session':'paged_search-s0','arguments':args_search});assert res['failure'] is None
        value=json.loads(res['output']['content']);hits.extend(value['matches']);pages+=1
        if value['complete']:break
        args_search=value['next_call']
        assert pages<20
    assert len(hits)>=7 and pages>=3
    history_checks.update(search_pages=pages,search_hits=len(hits),crossed_scan_and_hit_bounds=True)
    for invalid in [{'action':'read','seq':999999},{'action':'read','archive':key,'limit':2049},{'action':'read','archive':key,'session':'other'},{'action':'read','archive':key,'seq':1}]:
        res=bridge.call({'op':'history','session':c['id'],'arguments':invalid});assert res['failure'] is not None
    foreign=bridge.call({'op':'history','session':'join-s0','arguments':{'action':'read','archive':key}});assert foreign['failure'] is not None
    history_checks['schema_missing_event_cross_session_negatives']=True
    receipt={'cases':checks,'history':history_checks,'status':'passed'}
    (args.output/'offline-validation.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(dump(receipt))
finally:bridge.close()
