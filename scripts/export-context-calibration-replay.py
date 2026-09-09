#!/usr/bin/env python3
"""Export numeric-only calibration observations from a native session journal.
No prompts, tool arguments, keys or paths are emitted. Offline replay measures
recorded request surfaces, not retroactive provider-tokenizer ground truth.
"""
import hashlib
import json
import sys


def features(body):
    f = dict(buckets=[0, 0, 0], framing=0, image_tokens=0)

    def walk(v, structured=False):
        if isinstance(v, str):
            if v.startswith('data:image/'):
                return
            for c in v:
                f['buckets'][2 if not c.isascii() else 1 if structured else 0] += len(c.encode())
        elif isinstance(v, list):
            for x in v:
                f['framing'] += 8
                walk(x, structured)
        elif isinstance(v, dict):
            for k, x in v.items():
                if k in ('max_tokens', 'max_output_tokens', 'stream', 'stream_options', 'store'):
                    continue
                f['framing'] += len(k.encode()) + 4
                walk(x, structured or k in ('tools', 'tool_calls', 'arguments', 'parameters') or v.get('role') == 'tool' or v.get('type') == 'function_call_output')
        else:
            f['framing'] += 8
    walk(body)
    return f


def main(path):
    events = [e for line in open(path) for e in json.loads(line).get('events', [])]
    headers = [i for i, e in enumerate(events) if e['event']['type'] == 'request/header']
    for n, begin in enumerate(headers):
        end = headers[n+1] if n+1 < len(headers) else len(events)
        h = events[begin]['event']['data']['header']
        usage = None
        for e in events[begin+1:end]:
            d = e['event']['data']
            chunk = d.get('chunk', {})
            if e['event']['type'] == 'assistant/chunk' and chunk.get('kind', chunk.get('type')) == 'usage':
                usage = chunk.get('usage', chunk.get('data'))
        if not usage:
            continue
        messages = []
        for m in h.get('input', []):
            msg = {k: m[k] for k in ('role', 'content', 'tool_call_id') if k in m}
            if m.get('reasoning'):
                msg['reasoning_content'] = m['reasoning']
            if m.get('tool_calls'):
                msg['tool_calls'] = [{'id': c.get('provider_call_id') or c['id'], 'type': 'function', 'function': {'name': c['name'], 'arguments': c['arguments_json']}} for c in m['tool_calls']]
            # Same known-envelope, lossless projection as the provider.
            if m.get('role') == 'tool':
                try:
                    outer = json.loads(m['content'])
                    inner = json.loads(outer['content'])
                    if isinstance(outer.get('ok'), bool) and isinstance(outer.get('truncated'), bool) and isinstance(inner, dict) and any(k in inner for k in ('exit_code', 'job_id', 'bytes_read')):
                        outer['content'] = inner
                        msg['content'] = json.dumps(outer, ensure_ascii=False, separators=(',', ':'))
                except (KeyError, TypeError, ValueError):
                    pass
            messages.append(msg)
        controls = dict(model=h.get('model'), provider=h.get('provider'), tools=h.get('tools', []))
        scope = hashlib.sha256(json.dumps(controls, sort_keys=True).encode()).hexdigest()
        body = dict(model=h.get('model'), messages=messages, tools=[{'type': 'function', 'function': t} for t in h.get('tools', [])])
        actual = sum(usage.get(snake, usage.get(camel, 0)) for snake, camel in [('input_tokens', 'inputTokens'), ('cache_read_tokens', 'cacheReadTokens'), ('cache_write_tokens', 'cacheWriteTokens')])
        budget = h.get('options', {}).get('tokenBudget', {})
        print(json.dumps(dict(scope=scope, request_id=str(n+1), features=features(body), actual=actual, old_estimate=budget.get('estimate', {}).get('totalInputTokens', 0))))


if __name__ == '__main__':
    main(sys.argv[1])
