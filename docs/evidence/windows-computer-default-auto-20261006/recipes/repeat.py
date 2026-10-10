from experiment import *
import sys
for label in ['auto-1','auto-2']:
 d=ROOT/'setup'/label
 v,_=native({'action':'observe','include_accessibility':False,'include_screenshot':False},d)
 assert v['ok'] and any(x.get('frontmost') and 'XHarness Shopping Load Lab' in x.get('title','') for x in v['result']['surfaces']), 'Wrong foreground for reset'
 frame=v['result']['frame_id']
 v,_=native({'action':'keypress','keys':['F5'],'frame_id':frame,'observe_after':'never','include_accessibility':False,'include_screenshot':False},d)
 assert v['ok'],'Reset failed; never replay'
 for _ in range(20):
  events=[json.loads(x) for x in local('/shop-history').decode().splitlines()]
  if events and events[-1].get('type')=='initial' and events[-1].get('query')=='':break
  time.sleep(.5)
 else:raise RuntimeError('No fresh initial event')
 with (ROOT/f'{label}.log').open('w') as log:
  p=subprocess.run([sys.executable,'-u',str(ROOT/'default-loop.py'),label],stdout=log,stderr=subprocess.STDOUT)
 summary=json.loads((ROOT/'loop'/label/'summary.json').read_text())
 if p.returncode or summary.get('error'):raise RuntimeError(f'{label} failed; independent failure retained')
 print(label,'complete',len(summary['calls']),'calls',round(summary['elapsed_s'],2),'s',flush=True)
