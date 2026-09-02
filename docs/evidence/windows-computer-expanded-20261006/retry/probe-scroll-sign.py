from experiment import *
d=ROOT/'diagnostic'/'scroll-sign';d.mkdir(parents=True,exist_ok=False)
events=lambda:[json.loads(x) for x in local('/shop-history').decode().splitlines()]
before=events()
v,_=native({'action':'observe','include_accessibility':False,'include_screenshot':False},d)
assert v['ok'] and any(x.get('frontmost') and 'XHarness Shopping Load Lab' in x.get('title','') for x in v['result']['surfaces']), 'Wrong foreground; stop'
# Independent setup only, after model experiment has finished. No action replay.
for a in [{'action':'keypress','keys':['L'],'modifiers':['ctrl']},{'action':'type','text':'http://10.0.2.2:18098/expanded.html?case=scroll-detail'},{'action':'keypress','keys':['Enter']}]:
 a.update(frame_id=v['result']['frame_id'],include_accessibility=False,include_screenshot=False)
 v,_=native(a,d);assert v['ok'],'Reset failed; never replay'
for _ in range(30):
 es=events()
 if len(es)>len(before) and es[-1].get('type')=='initial' and es[-1].get('scenario')=='scroll-detail':break
 time.sleep(.5)
else:raise RuntimeError('No fresh diagnostic baseline')
# New document observation, then focus harmless heading so native wheel targets page.
v,_=native({'action':'observe','include_accessibility':False,'include_screenshot':False},d);assert v['ok']
v,_=native({'action':'click','frame_id':v['result']['frame_id'],'x':500,'y':24,'include_accessibility':False,'include_screenshot':False},d);assert v['ok']
baseline_events=events();baseline_y=baseline_events[-1]['scrollY'];(d/'before-events.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in baseline_events))
positions=[]
for delta in [360,-360]:
 baseline=len(events());v,_=native({'action':'scroll','frame_id':v['result']['frame_id'],'x':600,'y':600,'delta_y':delta,'include_accessibility':False,'include_screenshot':False},d)
 assert v['ok'],'Diagnostic failed; do not replay'
 for _ in range(20):
  fresh=events()[baseline:];scrolls=[e for e in fresh if e['type']=='scroll']
  if scrolls:break
  time.sleep(.25)
 else:raise RuntimeError('No external scroll evidence')
 positions.append({'delta_y':delta,'scrollY':scrolls[-1]['scrollY'],'receipt_id':v['id']})
after=events();(d/'after-events.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in after))
result={'positive_moves_down':positions[0]['scrollY']>baseline_y,'negative_moves_up':positions[1]['scrollY']<positions[0]['scrollY'],'positions':positions,'baseline_scrollY':baseline_y,'model_controlled':False,'observation_settings':'AX/screenshot disabled for diagnostic only; avoids WAN media latency','production_runtime_modified':False}
(d/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
