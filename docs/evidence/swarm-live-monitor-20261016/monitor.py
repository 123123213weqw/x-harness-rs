from importlib.machinery import SourceFileLoader
from pathlib import Path
import json,time,collections
rpc=SourceFileLoader('swarm_rpc','/tmp/swarm-live-rpc.py').load_module().rpc
p=Path('/tmp/swarm-scale12-live.json');s=json.loads(p.read_text());owner=s['owner'];team=s['team'];start=time.time();enabled=False;last=None;peak=0
log=Path('/tmp/swarm-scale12-observations.jsonl')
def emit(v):
 line=json.dumps(v);print(line,flush=True)
 with log.open('a') as f:f.write(line+'\n')
def stop():
 for worker in s['workers'].values():
  try:rpc('subagent.interrupt',{'parentSessionId':owner,'childSessionId':worker})
  except Exception:pass
 try:rpc('session.cancel',{'sessionId':owner})
 except Exception:pass
try:
 while True:
  view=rpc('swarm/manage',{'ownerSessionId':owner,'command':{'action':'inspect','swarmId':team}})
  board=rpc('swarm/tasks',{'ownerSessionId':owner,'command':{'action':'list','swarmId':team,'includeSettled':True,'limit':50}})
  tasks=board['tasks'];summaries=[{'id':r['task']['id'],'title':r['task']['title'],'ready':r['ready'],'state':r['task']['state']} for r in tasks]
  session=next(x for x in rpc('session.list',{})['items'] if x['sessionId']==owner)
  stats=session.get('projections',{}).get('values',{}).get('sessionStats',{});turns=stats.get('turns',0)
  counts=dict(collections.Counter(w['activity'] for w in view['workers']));peak=max(peak,counts.get('running',0))
  snapshot={'elapsedSeconds':round(time.time()-start,1),'ownerRunning':session.get('running'),'ownerTurns':turns,'workers':counts,'autoDispatch':view['swarm']['autoDispatch'],'tasks':summaries}
  signature=json.dumps([summaries,session.get('running'),turns,counts],sort_keys=True)
  if signature!=last:emit(snapshot);last=signature
  if len(tasks)>13 or turns>60 or time.time()-s['started']>600:
   stop();raise RuntimeError('Bounded test limit reached; only test actors stopped')
  if not enabled and len(tasks)==13 and not session.get('running'):
   assert {r['task']['title'] for r in tasks}=={*[f'Scale {i:02}' for i in range(1,13)],'Scale checksum'}
   ids={r['task']['title']:r['task']['id'] for r in tasks}
   for i in range(1,13):
    task=next(r['task'] for r in tasks if r['task']['title']==f'Scale {i:02}')
    assert not task['dependencies'] and task['eligibleWorkerSessionIds']==[s['workers'][f'Range {i:02}']]
   aggregate=next(r['task'] for r in tasks if r['task']['title']=='Scale checksum')
   assert set(aggregate['dependencies'])=={ids[f'Scale {i:02}'] for i in range(1,13)}
   assert aggregate['eligibleWorkerSessionIds']==[s['workers']['Range 01']]
   rpc('swarm/manage',{'ownerSessionId':owner,'command':{'action':'set_dispatch','swarmId':team,'expectedRevision':view['swarm']['revision'],'enabled':True}})
   enabled=True;s['phase']='executing';s['dispatchStarted']=time.time();p.write_text(json.dumps(s,indent=2)+'\n');emit({'humanEnabledAutoDispatch':True})
  if len(tasks)==13 and all(r['task']['state']['status']=='settled' for r in tasks) and not session.get('running'):
   passed=all(r['task']['state']['outcome']=='completed' for r in tasks)
   s.update(phase='accepted' if passed else 'failed',passed=passed,elapsedSeconds=round(time.time()-start,1),dispatchElapsedSeconds=round(time.time()-s.get('dispatchStarted',start),1),tasks=summaries,ownerStats=stats,peakObservedRunningWorkers=peak)
   p.write_text(json.dumps(s,indent=2)+'\n');emit({'completed':True,'passed':passed,'peakObservedRunningWorkers':peak});break
  time.sleep(2)
except Exception as error:
 stop();s.update(phase='test-error',error=str(error));p.write_text(json.dumps(s,indent=2)+'\n');emit({'error':str(error)});raise
