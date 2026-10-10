from pathlib import Path
import json,importlib.util
from report_answer import reported_answer
ROOT=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('oracle',ROOT/'grade-expanded.py');o=importlib.util.module_from_spec(s);s.loader.exec_module(o)
rows=[];tokens={'prompt_tokens':0,'completion_tokens':0,'cache_hit':0,'cache_miss':0};responses=0
for case in o.TASKS:
 d=ROOT/'loop'/case;summary=json.loads((d/'summary.json').read_text());es=[json.loads(x) for x in (d/'events.jsonl').read_text().splitlines()]
 final={};strict=None;format_error=None
 if (d/'final.txt').exists():
  try:final,strict,_=reported_answer((d/'final.txt').read_text())
  except Exception as e:format_error=str(e)
 else:format_error='No final answer; bounded experiment stopped'
 g=o.grade(case,final,es,summary['error']);g.update(strict_final_json=strict,format_error=format_error,tool_calls=len(summary['calls']),tool_failures=sum(x['ok'] is not True for x in summary['calls']),elapsed_s=round(summary['elapsed_s'],2),controller_error=summary['error'])
 (d/'grade.json').write_text(json.dumps(g,indent=2));rows.append(g)
 for u in summary['usage']:
  responses+=1;tokens['prompt_tokens']+=u.get('prompt_tokens',0);tokens['completion_tokens']+=u.get('completion_tokens',0);tokens['cache_hit']+=u.get('prompt_cache_hit_tokens',u.get('prompt_tokens_details',{}).get('cached_tokens',0));tokens['cache_miss']+=u.get('prompt_cache_miss_tokens',u.get('prompt_tokens',0)-u.get('prompt_tokens_details',{}).get('cached_tokens',0))
report={'model':'deepseek-flash','source_sha':json.loads((ROOT/'ready.json').read_text())['source_sha'],'runtime_changed':False,'cases':rows,'usage':tokens,'responses':responses,'actual_billed_cost_unavailable':True}
(ROOT/'results-initial.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
