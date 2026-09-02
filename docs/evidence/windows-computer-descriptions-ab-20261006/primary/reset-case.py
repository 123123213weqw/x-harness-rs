from experiment import *
import sys
case=sys.argv[1];label=sys.argv[2];assert case in ('filter','scroll-detail')
d=ROOT/'setup'/label;before=[json.loads(x) for x in local('/shop-history').decode().splitlines()]
v,_=native({'action':'observe','include_accessibility':False,'include_screenshot':False},d)
assert v['ok'] and any(s.get('frontmost') and 'XHarness Shopping Load Lab' in s.get('title','') for s in v['result']['surfaces'])
for a in [{'action':'keypress','keys':['L'],'modifiers':['ctrl']},{'action':'type','text':'http://10.0.2.2:18100/expanded.html?case='+case},{'action':'keypress','keys':['Enter']}]:
 a.update(frame_id=v['result']['frame_id'],include_accessibility=False,include_screenshot=False)
 v,_=native(a,d);assert v['ok'],'Reset failed; never replay'
for _ in range(30):
 es=[json.loads(x) for x in local('/shop-history').decode().splitlines()]
 if len(es)>len(before) and es[-1].get('type')=='initial' and es[-1].get('scenario')==case:break
 time.sleep(.5)
else:raise RuntimeError('No fresh reset')
print('Fresh reset verified')
