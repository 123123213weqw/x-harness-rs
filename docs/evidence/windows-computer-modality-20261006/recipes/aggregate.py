from experiment import *
from grade import grade_loop,grade_static
import statistics
rows=[];all_usage=[]
static=json.loads((ROOT/'static/results.json').read_text());oracle=json.loads((ROOT/'static/oracle.json').read_text())
for mode in MODES:
    samples=[x for x in static if x['mode']==mode]
    rows.append({'kind':'same_snapshot','mode':mode,'passed':sum(grade_static(x['answer'],oracle)['pass'] for x in samples),'samples':len(samples),'input_tokens_per_request':[x['usage']['prompt_tokens'] for x in samples],'median_model_s':statistics.median(x['model_s'] for x in samples)})
    all_usage.extend({'category':'same_snapshot','mode':mode,**x['usage']} for x in samples)
for p in sorted((ROOT/'loop').iterdir()):
    if not (p/'summary.json').exists():continue
    summary=json.loads((p/'summary.json').read_text());grade=None
    if (p/'final.txt').exists():
        try:
            final,strict=parse_final((p/'final.txt').read_text());grade=grade_loop(summary,final,[json.loads(x) for x in (p/'events.jsonl').read_text().splitlines()]);grade['strict_final_json']=strict
        except (ValueError,TypeError):grade={'pass':False,'final_parse_failed':True}
        (p/'grade.json').write_text(json.dumps(grade,indent=2))
    receipts=[json.loads(x.read_text()) for x in p.glob('receipt-*.json')]
    obs=[v for v in receipts if (v.get('result') or {}).get('action')=='observe']
    failures=[{'id':v['id'],'failure':v.get('failure')} for v in receipts if not v.get('ok')]
    peaks=[s.get('native_rss_bytes') or 0 for v in receipts for s in v.get('resource_samples',[])]
    rows.append({'kind':'loop','label':p.name,'mode':summary['mode'],'grade':grade,'error':summary['error'],'native_calls':len(summary['calls']),'native_observation_median_ms':statistics.median(v['elapsed_ms'] for v in obs) if obs else None,'native_observations':len(obs),'model_s':sum(x['model_s'] for x in json.loads((p/'transcript.json').read_text())),'controller_total_s':summary['elapsed_s'],'native_peak_working_set_bytes':max(peaks) if peaks else None,'failures':failures,'reported_prompt_tokens':sum(u.get('prompt_tokens',0) for u in summary['usage'])})
    all_usage.extend({'category':'loop','label':p.name,**u} for u in summary['usage'])
for x in json.loads((ROOT/'canary-results.json').read_text()):all_usage.append({'category':'vision_canary',**x['usage']})
all_usage.append({'category':'tool_image_compatibility',**json.loads((ROOT/'tool-image-compatibility.json').read_text())['usage']})
pt=sum(u.get('prompt_tokens',0) for u in all_usage);ct=sum(u.get('completion_tokens',0) for u in all_usage);hit=sum(u.get('prompt_cache_hit_tokens',u.get('prompt_tokens_details',{}).get('cached_tokens',0)) for u in all_usage);miss=pt-hit
cost=(hit*.006+miss*.30+ct*1.20)/1000000
ledger={'requests_with_usage':len(all_usage),'prompt_tokens':pt,'completion_tokens':ct,'cache_hit_tokens':hit,'cache_miss_tokens':miss,'conservative_peak_tariff_usd_per_million':{'hit':.006,'miss':.30,'output':1.20},'estimated_usd_upper_bound':cost,'actual_billed_amount':'not available per request','pricing_source':'https://api-docs.deepseek.com/quick_start/pricing/','includes_aborted_trials':True,'entries':all_usage}
(ROOT/'comparison.json').write_text(json.dumps(rows,indent=2));(ROOT/'cost-ledger.json').write_text(json.dumps(ledger,indent=2));print(json.dumps(rows,indent=2));print(json.dumps({k:v for k,v in ledger.items() if k!='entries'},indent=2))
