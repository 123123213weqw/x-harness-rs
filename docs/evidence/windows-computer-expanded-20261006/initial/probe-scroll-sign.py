from experiment import *
d=ROOT/'diagnostic'/'scroll-sign';d.mkdir(parents=True,exist_ok=False)
events=lambda:[json.loads(x) for x in local('/shop-history').decode().splitlines()]
before=events();(d/'before-events.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in before))
v,_=native({'action':'observe','include_accessibility':False,'include_screenshot':True},d)
assert v['ok'] and any(x.get('frontmost') and 'XHarness Shopping Load Lab' in x.get('title','') for x in v['result']['surfaces']), 'Wrong foreground; stop'
positions=[]
for delta in [360,-360]:
 baseline=len(events());v,_=native({'action':'scroll','frame_id':v['result']['frame_id'],'x':600,'y':600,'delta_y':delta,'include_accessibility':False,'include_screenshot':True},d)
 assert v['ok'],'Diagnostic failed; do not replay'
 for _ in range(10):
  fresh=events()[baseline:];scrolls=[e for e in fresh if e['type']=='scroll']
  if scrolls:break
  time.sleep(.25)
 else:raise RuntimeError('No external scroll evidence')
 positions.append({'delta_y':delta,'scrollY':scrolls[-1]['scrollY'],'receipt_id':v['id']})
after=events();(d/'after-events.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in after))
result={'positive_moves_down':positions[0]['scrollY']>before[-1]['scrollY'],'negative_moves_up':positions[1]['scrollY']<positions[0]['scrollY'],'positions':positions,'baseline_scrollY':before[-1]['scrollY'],'model_controlled':False}
(d/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
