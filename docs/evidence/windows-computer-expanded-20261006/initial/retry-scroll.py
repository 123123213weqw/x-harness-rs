from experiment import *
import sys
for case in ('scroll-detail',):
 if case!='filter':
  d=ROOT/'setup'/case
  # Setup-only page reset, separate from the model history and score.
  v,_=native({'action':'observe','include_accessibility':False,'include_screenshot':False},d)
  assert v['ok'] and any(x.get('frontmost') and 'XHarness Shopping Load Lab' in x.get('title','') for x in v['result']['surfaces']), 'Wrong foreground for reset'
  for args in [{'action':'keypress','keys':['L'],'modifiers':['ctrl']},{'action':'type','text':'http://10.0.2.2:18097/expanded.html?case='+case},{'action':'keypress','keys':['ENTER']}]:
   args['frame_id']=v['result']['frame_id'];args['include_accessibility']=False;args['include_screenshot']=False
   v,_=native(args,d);assert v['ok'],'Reset failed; do not replay'
  for _ in range(30):
   es=[json.loads(x) for x in local('/shop-history').decode().splitlines()]
   if es and es[-1].get('type')=='initial' and es[-1].get('scenario')==case and es[-1].get('query')=='':break
   time.sleep(.5)
  else:raise RuntimeError('No fresh scenario baseline')
 with (ROOT/'scroll-detail-retry.log').open('w') as log:
  p=subprocess.run([sys.executable,'-u',str(ROOT/'run-case.py'),case,'scroll-detail-retry'],stdout=log,stderr=subprocess.STDOUT)
 summary_path=ROOT/'loop'/'scroll-detail-retry'/'summary.json'
 if not summary_path.exists():raise RuntimeError('Controller crashed; do not continue')
 summary=json.loads(summary_path.read_text());print(case,'complete',len(summary['calls']),'calls',round(summary['elapsed_s'],2),'s',summary['error'],flush=True)
 # Model/tool errors retained; only unknown external outcome stops the entire suite.
 if p.returncode or (summary.get('error') and any(x in summary['error'].lower() for x in ('receipt','bridge exited','png','foreground'))):raise RuntimeError('Uncertain environment; stop without replay')
