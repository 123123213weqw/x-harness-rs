"""Summarize retained paired rows without turning missing evidence into scores."""
import argparse
import json
from pathlib import Path


def summarize(rows):
    seen = set()
    trials = []
    for row in rows:
        identity = (row['task'], row['harness'])
        if identity in seen:
            raise ValueError('duplicate trial: do not select best-of results')
        seen.add(identity)
        budget = row.get('budget', {})
        calls = budget.get('rows', [])
        usage = [call['usage'] for call in calls if call.get('usage') is not None]
        complete = len(usage) == budget.get('requests', 0) and not budget.get('inflight', 0)
        status = row.get('grade', {}).get('status')
        trials.append(dict(task=identity[0], harness=identity[1],
            grade=status if status in ('PASS', 'FAIL') else 'NA', termination=row['termination'],
            input_tokens_known=sum(u['prompt_tokens'] for u in usage),
            output_tokens_known=sum(u['completion_tokens'] for u in usage),
            cache_hit_tokens_known=sum(u.get('prompt_cache_hit_tokens', 0) for u in usage),
            usage_complete=complete, requests=budget.get('requests', 0),
            conservative_usd=budget.get('conservative_usd', 0), elapsed_seconds=row.get('elapsed_seconds'),
            response_models=sorted({call.get('evidence', {}).get('response_model') for call in calls
                                    if call.get('evidence', {}).get('response_model')})))
    tasks = sorted({t['task'] for t in trials})
    paired = []
    common = []
    for task in tasks:
        group = {t['harness']: t for t in trials if t['task'] == task}
        if set(group) != {'xharness', 'official'} or any(t['grade'] == 'NA' for t in group.values()):
            paired.append({'task': task, 'outcome': 'NA'})
        else:
            a, b = group['xharness']['grade'], group['official']['grade']
            outcome = 'tie' if a == b else 'xharness' if a == 'PASS' else 'official'
            paired.append({'task': task, 'outcome': outcome})
            if a == b == 'PASS':
                common.append(task)
    comparable = [t for t in trials if t['task'] in common]
    efficiency = None
    if comparable and all(t['usage_complete'] for t in comparable):
        efficiency = {h: {'input_tokens': sum(t['input_tokens_known'] for t in comparable if t['harness'] == h),
                          'output_tokens': sum(t['output_tokens_known'] for t in comparable if t['harness'] == h),
                          'requests': sum(t['requests'] for t in comparable if t['harness'] == h)}
                      for h in ('xharness', 'official')}
    return {'trials': trials, 'paired': paired, 'common_pass_tasks': common,
            'common_pass_efficiency': efficiency,
            'total_conservative_usd': sum(t['conservative_usd'] for t in trials),
            'limitations': ['one sample per cell', 'selected development tasks, not leaderboard',
                            'known tokens are lower bounds when usage_complete=false',
                            'all failed/NA trial costs retained; conservative dollars are not an invoice']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(json.loads(args.report.read_text())), indent=2))
