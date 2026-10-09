from experiment import *
from grade import grade_loop
from report_answer import reported_answer
import statistics
rows=[];usage=[]
for p in sorted((ROOT/'loop').iterdir()):
 s=json.loads((p/'summary.json').read_text());f,strict,format_style=reported_answer((p/'final.txt').read_text());e=[json.loads(x) for x in (p/'events.jsonl').read_text().splitlines()]
 g=grade_loop(s,f,e);g['strict_final_json']=strict;g['format_style']=format_style;(p/'grade.json').write_text(json.dumps(g,indent=2))
 reqs=[{'id':int(q.stem.split('-')[1]),'args':json.loads(q.read_text())} for q in sorted(p.glob('request-*.json'),key=lambda q:int(q.stem.split('-')[1]))]
 receipts=[json.loads(q.read_text()) for q in p.glob('receipt-*.json')]
 rows.append({'label':p.name,'grade':g,'calls':s['calls'],'model_choices':reqs,'elapsed_s':s['elapsed_s'],'native_all_call_median_ms':statistics.median(x['elapsed_ms'] for x in s['calls']),'failures':[{'id':v['id'],'failure':v.get('failure')} for v in receipts if not v['ok']],'input_tokens':sum(u.get('prompt_tokens',0) for u in s['usage'])})
 usage.extend(s['usage'])
h=sum(u.get('prompt_cache_hit_tokens',0) for u in usage);miss=sum(u.get('prompt_cache_miss_tokens',u.get('prompt_tokens',0)-u.get('prompt_cache_hit_tokens',0)) for u in usage);out=sum(u.get('completion_tokens',0) for u in usage)
ledger={'requests_with_usage':len(usage),'prompt_tokens':sum(u.get('prompt_tokens',0) for u in usage),'completion_tokens':out,'cache_hit_tokens':h,'cache_miss_tokens':miss,'estimated_usd_upper_bound':(h*.006+miss*.30+out*1.20)/1e6,'actual_billed_amount':'not available per request','conservative_peak_tariff_usd_per_million':{'hit':.006,'miss':.30,'output':1.20},'pricing_source':'https://api-docs.deepseek.com/quick_start/pricing/','entries':usage}
(ROOT/'comparison.json').write_text(json.dumps(rows,indent=2));(ROOT/'cost-ledger.json').write_text(json.dumps(ledger,indent=2));print(json.dumps(rows,indent=2));print(json.dumps({k:v for k,v in ledger.items() if k!='entries'}))
