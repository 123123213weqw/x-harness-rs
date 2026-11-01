from importlib.machinery import SourceFileLoader
from pathlib import Path
import json,time
rpc=SourceFileLoader('swarm_rpc','/tmp/swarm-live-rpc.py').load_module().rpc
path=Path('/tmp/swarm-scale12-live.json');s=json.loads(path.read_text());owner=s['owner'];team=s['team']
entries=rpc('subagent.list',{'parentSessionId':owner})['entries']
assert len(entries)==12,len(entries)
workers={e['label']:e['id'] for e in entries}
assert set(workers)=={f'Range {i:02}' for i in range(1,13)},list(workers)
for entry in entries:
 view=rpc('swarm/manage',{'ownerSessionId':owner,'command':{'action':'inspect','swarmId':team}})
 if entry['id'] not in view['swarm']['members']:
  rpc('swarm/manage',{'ownerSessionId':owner,'command':{'action':'attach_member','swarmId':team,'expectedRevision':view['swarm']['revision'],'childSessionId':entry['id']}})
s.update(workers=workers,phase='board-preparation',maxOwnerTurns=60);path.write_text(json.dumps(s,indent=2)+'\n')
lines=[]
for i in range(1,13):
 lo=10*(i-1)+1;hi=10*i
 lines.append(f'{i}. Title "Scale {i:02}". Eligible worker Range {i:02} ({workers[f"Range {i:02}"]}). No dependencies. Instructions: "Compute the sum of the integers {lo} through {hi}, inclusive, independently. Return RANGE_{i:02}=<sum>, followed by one short sentence identifying the range. Do not use tools, message anyone, or create agents."')
prompt=f'''Stage 2 of the same finite 12-worker Swarm test. All twelve existing workers are linked to team {team}. Do not create further workers. Use only the agent tool, action=tasks. Read the board and create exactly the following 13 tasks. Use each successful add response's updated revision for the next add, or list for a fresh revision on conflict. Do not re-add an existing title.
'''+ '\n'.join(lines)+f'''
13. Title "Scale checksum". Eligible worker Range 01 ({workers['Range 01']}). Dependencies: all twelve exact task IDs from Scale 01..Scale 12. Instructions: "Read all twelve accepted dependency summaries supplied with this assignment. Extract their computed sums in range order, add them and return CHECKSUM=<total>, followed by the 12 source values. Do not use tools, message anyone or create agents."
Automatic dispatch is OFF while you prepare the board. Do not manually assign tasks, send follow-ups, enable dispatch, or poll worker histories. After all thirteen tasks exist, reply BOARD_PREPARED and end the turn. The human driver will enable automatic dispatch.
For later native worker-result notifications, review the real board through tasks/list. Review each actual finished assignment using its exact attempt.execution_ref; require a completed turn and the correct independently recomputed range sum, and include RANGE_NN=<value> in each acceptance summary. Mark a wrong result failed rather than pretending success. For the dependent checksum, validate all twelve values and require CHECKSUM=7260. Native notifications can coalesce: inspect all reviewable tasks in a turn, not just the first one. When no tasks are reviewable, end and wait for the next native notification rather than repeatedly polling. Do not create more tasks or workers in any turn. After all thirteen are accepted, return SWARM_SCALE12_PASS 7260. This is a bounded arithmetic orchestration test, not a recurring goal.'''
print(json.dumps({'linkedWorkers':len(workers),'promptAccepted':rpc('session.prompt',{'sessionId':owner,'mode':'queue','content':[{'type':'text','text':prompt}]})}))
