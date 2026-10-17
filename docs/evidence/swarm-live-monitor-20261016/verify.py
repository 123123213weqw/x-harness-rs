"""Verify the finite 12-worker run from its own durable journals; never read reasoning."""
from pathlib import Path
import argparse
import collections
import hashlib
import json
import re

parser = argparse.ArgumentParser()
parser.add_argument('run', type=Path)
args = parser.parse_args()
run = args.run
state = json.loads((run / 'scale12-test-state.json').read_text())
owner, team = state['owner'], state['team']
assert state['passed'] and len(state['workers']) == 12 and len(state['tasks']) == 13


def events(path):
    return [event for line in path.read_text().splitlines()
            for event in json.loads(line).get('events', [])]


def public_text(message):
    content = message.get('content', '')
    return content if isinstance(content, str) else ''.join(
        part.get('text', '') for part in content if part.get('type') == 'text')


session_dir = run / 'state-ui' / 'sessions'
paths = [run / 'state-ui/control/host-control.jsonl', session_dir / f'{owner}.jsonl']
worker_events = {}
for worker in state['workers'].values():
    path = session_dir / f'{worker}.jsonl'
    paths.append(path)
    worker_events[worker] = events(path)
answers, consuming_turns, consumed_counts, intervals = {}, {}, {}, []
expected = {f'Scale {i:02}': (f'RANGE_{i:02}', sum(range(10 * (i - 1) + 1, 10 * i + 1)))
            for i in range(1, 13)}
expected['Scale checksum'] = ('CHECKSUM', 7260)
for row in state['tasks']:
    task = row['state']
    assert task['status'] == 'settled' and task['outcome'] == 'completed'
    worker, message_id = task['workerSessionId'], task['messageId']
    turn, starts, ends = None, {}, {}
    messages, answer = [], collections.defaultdict(str)
    for envelope in worker_events[worker]:
        event = envelope['event']
        kind, data = event['type'], event.get('data', {})
        if kind == 'turn/start':
            turn = data['turn']
            starts[turn] = envelope['timestamp_ms']
        if kind == 'user/message' and data.get('message', {}).get('id') == message_id:
            messages.append(turn)
        if kind == 'assistant/message':
            answer[turn] += public_text(data.get('message', {}))
        if kind == 'turn/end':
            ends[data['turn']] = (data['reason']['kind'], envelope['timestamp_ms'])
    assert messages == [task['turn']], (row['title'], messages, task['turn'])
    assert ends[task['turn']][0] == 'completed'
    text = answer[task['turn']]
    key, value = expected[row['title']]
    assert re.search(r'\b' + key + r'\s*=\s*' + str(value) + r'\b', text), (row['title'], text)
    if row['title'] == 'Scale checksum':
        assert all(re.search(r'\b' + str(expected[f'Scale {i:02}'][1]) + r'\b', text)
                   for i in range(1, 13)), text
    answers[row['title']] = text
    consuming_turns[row['id']], consumed_counts[row['id']] = task['turn'], len(messages)
    intervals.extend([(starts[task['turn']], 1), (ends[task['turn']][1], -1)])
# Completed turns are not task acceptance. Verify dependency gating in Control.
claims, accepts = {}, {}
for envelope in events(paths[0]):
    data = envelope['event'].get('data', {})
    change = data.get('change', {})
    if change.get('id') != team:
        continue
    detail = change.get('change', {})
    if detail.get('kind') == 'claimed':
        assert detail['task_id'] not in claims, 'Duplicate claim'
        claims[detail['task_id']] = envelope['seq']
    if detail.get('kind') == 'settled':
        assert detail['task_id'] not in accepts, 'Duplicate acceptance'
        accepts[detail['task_id']] = envelope['seq']
by_title = {row['title']: row['id'] for row in state['tasks']}
assert set(claims) == set(accepts) == set(by_title.values())
assert claims[by_title['Scale checksum']] > max(accepts[by_title[f'Scale {i:02}']] for i in range(1, 13))
calls, final_answers = [], []
for envelope in events(paths[1]):
    event = envelope['event']
    if event['type'] != 'assistant/message':
        continue
    message = event['data'].get('message', {})
    final_answers.append(public_text(message))
    for call in message.get('tool_calls', []):
        params = json.loads(call['arguments_json'])
        calls.append({'name': call['name'], 'action': params.get('action'),
                      'command': params.get('command', {}).get('action')})
assert all(call['name'] == 'agent' for call in calls)
assert sum(call['action'] == 'start' for call in calls) == 12
assert sum(call['command'] == 'add' for call in calls) == 13
assert sum(call['command'] == 'review' for call in calls) == 13
assert not any(call['action'] in {'send', 'revert', 'stop'} or call['command'] == 'assign' for call in calls)
assert any('SWARM_SCALE12_PASS 7260' in text for text in final_answers)
active, peak = 0, 0
for _, delta in sorted(intervals):
    active += delta
    peak = max(peak, active)
result = {
    'passed': True, 'provider': 'deepseek', 'model': 'deepseek-flash',
    'kind': 'bounded real arithmetic orchestration and live visibility test',
    'owner': owner, 'team': team, 'workers': 12, 'acceptedTasks': 13,
    'actualWorkerAnswers': answers, 'matchingAssignmentTurns': consuming_turns,
    'consumedDeliveryCounts': consumed_counts, 'claimControlSequences': claims,
    'acceptedControlSequences': accepts, 'coordinatorToolCalls': calls,
    'peakOverlappingAssignmentTurns': peak,
    'peakWorkersObservedRunningAtTwoSecondSampling': state['peakObservedRunningWorkers'],
    'dispatchStageSeconds': state['dispatchElapsedSeconds'],
    'humanDriver': 'Created isolated root/team, linked model-created workers, enabled dispatch; did not add/assign/review tasks.',
    'limits': {'workers': 12, 'tasks': 13, 'wallSeconds': 600, 'coordinatorTurns': 60},
    'notClaimed': ['coding-task quality', 'hundreds of concurrent workers', 'broad autonomy', 'Host/WebKit peak-memory benchmark'],
    'journalSha256': {str(path.relative_to(run)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},
}
(run / 'scale12-acceptance.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
