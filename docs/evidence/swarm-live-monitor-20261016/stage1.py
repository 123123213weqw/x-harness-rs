from importlib.machinery import SourceFileLoader
from pathlib import Path
import json,time
rpc=SourceFileLoader('swarm_rpc','/tmp/swarm-live-rpc.py').load_module().rpc
owner='swarm-scale12-'+str(int(time.time()))
rpc('session.create',{'sessionId':owner})
rpc('session.rename',{'sessionId':owner,'title':'Swarm · 12-agent live test'})
rpc('session.selectModel',{'sessionId':owner,'provider':'deepseek','model':'deepseek-flash','reasoningEffort':'low'})
team=rpc('swarm/manage',{'ownerSessionId':owner,'command':{'action':'create','objective':'12-agent live test: independent work and reviewed aggregation'}})['swarmId']
s={'owner':owner,'team':team,'started':time.time(),'phase':'worker-setup','maxSeconds':600,'maxOwnerTurns':35,'workers':{}}
Path('/tmp/swarm-scale12-live.json').write_text(json.dumps(s,indent=2)+'\n')
prompt='''This is a finite real Swarm scale test. Stage 1 only: create exactly 12 workers using agent action=start, labelled Range 01 through Range 12. Do not override provider/model/reasoning. Each initial task must be: "You are Range NN for a finite Swarm test. For this initial handshake only return READY. Do not compute anything until a later explicit Swarm board assignment. Do not call tools, message anyone, or create agents." Replace NN with the worker number. No further agent spawns are permitted after those twelve start calls. Do not create tasks, send follow-ups, assign work or poll worker histories in this stage. After starting all twelve, return WORKERS_PREPARED and end the turn. Ready notifications require no action: end any resulting turn without creating more work. The human test driver will link the workers and supply the next stage.'''
print(json.dumps({'owner':owner,'team':team,'promptAccepted':rpc('session.prompt',{'sessionId':owner,'mode':'queue','content':[{'type':'text','text':prompt}]})}))
