from experiment import *
import sys
ready=json.loads((ROOT/'ready.json').read_text());assert ready['phase']=='ready' and ready['source_sha']=='16c5568041b165a8136ac6c6fc09a4e864bde860'
(ROOT/'ready.json').write_text(json.dumps(ready,indent=2));started=time.monotonic()
for case,variant in [('filter','B')]:
 label=case+'-'+variant
 # Stop before a new trial if fixture lifetime cannot plausibly cover it.
 if time.monotonic()-started>880:
  (ROOT/'admission-stop.json').write_text(json.dumps({'next_label':label,'reason':'Experimental fixture lifetime; do not report unrun case as model failure'}));break
 for script,args in [('reset-case.py',[case,label]),('run-case.py',[case,label,variant])]:
  with (ROOT/(label+'-'+script+'.log')).open('w') as f:
   p=subprocess.run([sys.executable,'-u',str(ROOT/script),*args],stdout=f,stderr=subprocess.STDOUT)
  if p.returncode!=0:raise RuntimeError('Experiment controller failed; no input replay: '+label+' '+script)
 print('Finished '+label,flush=True)
local('/browser-job',{'stop':True})
for _ in range(60):
 v=json.loads(local('/browser-latest'))
 if v.get('phase')=='finished':
  (ROOT/'exit-receipt.json').write_text(json.dumps(v,indent=2));print('Probe exit: '+str(v.get('probe_alive')));break
 time.sleep(.5)
else:raise RuntimeError('No cleanup receipt; do not stop collector')
