#!/usr/bin/env python3
"""Explicit, offline migration of verified openai-wire/v2 text Chat audits.
Reads original journals/blobs, emits ONLY a numeric cache candidate. Never sends
requests, modifies history, credentials or the running app's state. Unsupported
or unverifiable records fail closed. This is not the normal runtime encoder.
"""
import argparse
import collections
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import time

spec = importlib.util.spec_from_file_location('numeric_features', Path(__file__).with_name('export-context-calibration-replay.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
features = module.features
TTL = 7 * 24 * 3600 * 1000
MAX_BLOB = 128 * 1024 * 1024


def canonical(v):
    # Float rendering differs between Python and serde_json. Do not guess.
    def check(x):
        if isinstance(x, float):
            raise ValueError('float in legacy wire structure')
        if isinstance(x, dict):
            for y in x.values(): check(y)
        if isinstance(x, list):
            for y in x: check(y)
    check(v)
    return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(v):
    return hashlib.sha256(canonical(v)).hexdigest()


def read_blob(root, key):
    if not isinstance(key, str) or len(key) != 64 or any(c not in '0123456789abcdef' for c in key):
        raise ValueError('invalid blob digest')
    path = root / (key + '.json')
    if root.is_symlink() or path.is_symlink() or not path.is_file():
        raise ValueError('invalid audit file')
    with path.open('rb') as f:
        data = f.read(MAX_BLOB + 1)
    if len(data) > MAX_BLOB or hashlib.sha256(data).hexdigest() != key:
        raise ValueError('corrupt audit blob')
    return json.loads(data)


def expand(root, header):
    ref = header.get('options', {}).get('auditSnapshot', {})
    if ref.get('kind') != 'archive' or ref.get('version') != 1:
        raise ValueError('unsupported audit layout')
    m = read_blob(root, ref['sha256'])
    if m.get('version') != 1 or len(m.get('input', [])) > 10000:
        raise ValueError('invalid audit manifest')
    # Tie the content-addressed manifest to the authoritative journal header.
    for k in ('provider', 'model'):
        if m['header'].get(k) != header.get(k): raise ValueError('audit identity mismatch')
    for k in ('measurement', 'tokenBudget', 'toolDefinitionsSha256'):
        if m['header']['options'].get(k) != header['options'].get(k): raise ValueError('audit metadata mismatch')
    messages = [read_blob(root, k) for k in m['input']]
    tools = read_blob(root, m['tools'])
    if len(messages) != header['options'].get('inputMessageCount') or len(tools) != header['options'].get('toolCount'):
        raise ValueError('audit count mismatch')
    return messages, tools


def encode(model, messages, tools, max_tokens, patch):
    wire = []
    for m in messages:
        if m.get('content_blocks') or m.get('contentBlocks'):
            raise ValueError('multimodal audit unsupported')
        msg = {'role': m['role'], 'content': m.get('content', '')}
        if msg['role'] == 'tool':
            try:
                outer = json.loads(msg['content'])
                inner = json.loads(outer['content'])
            except (KeyError, TypeError, ValueError):
                outer, inner = None, None
            if isinstance(outer, dict) and isinstance(outer.get('ok'), bool) and isinstance(outer.get('truncated'), bool) and isinstance(inner, dict) and any(k in inner for k in ('exit_code', 'job_id', 'bytes_read')):
                outer['content'] = inner
                msg['content'] = canonical(outer).decode()
        if m.get('reasoning'): msg['reasoning_content'] = m['reasoning']
        if m.get('tool_call_id') is not None: msg['tool_call_id'] = m['tool_call_id']
        if m.get('tool_calls'):
            msg['tool_calls'] = [{'id': c['provider_call_id'] if c.get('provider_call_id') is not None else c['id'], 'type': 'function', 'function': {'name': c['name'], 'arguments': c['arguments_json']}} for c in m['tool_calls']]
        wire.append(msg)
    body = {'model': model, 'stream': True, 'stream_options': {'include_usage': True}, 'messages': wire}
    if tools: body['tools'] = [{'type': 'function', 'function': {k: t[k] for k in ('name', 'description', 'parameters')}} for t in tools]
    if max_tokens is not None: body['max_tokens'] = max_tokens
    if set(patch) & {'model', 'messages', 'tools', 'max_tokens', 'stream', 'stream_options'}:
        raise ValueError('invalid reasoning patch')
    body.update(patch)
    return body


def scopes(endpoint, body, semantics):
    controls = {k: v for k, v in body.items() if k not in ('messages', 'input', 'max_tokens', 'max_output_tokens')}
    legacy = {'endpoint': endpoint, 'controls': controls, 'encoder': 'openai-wire/v2'}
    return digest(legacy), digest(dict(legacy, usageSemantics=semantics))


def sample(header, messages, tools, usage, timestamp, profile, model, semantics, now):
    if timestamp > now or now - timestamp > TTL: raise ValueError('expired usage')
    options = header['options']
    budget = options['tokenBudget']
    expected = budget['meter']
    if not expected.startswith('wire-calibration/v1:'): raise ValueError('unsupported meter')
    if header['model'] != model['id'] or header['provider'] != profile['id']: raise ValueError('route mismatch')
    if profile.get('protocol', 'chat') != 'chat': raise ValueError('only legacy text Chat is supported')
    endpoint = profile['base_url'].rstrip('/') + '/chat/completions'
    reasoning = model.get('reasoning') or {}
    patches = [{}] + [e['request_patch'] for e in reasoning.get('efforts', [])]
    matches = {}
    for patch in patches:
        body = encode(model.get('upstream_model') or model['id'], messages, tools, budget.get('selectedOutputTokens'), patch)
        old, new = scopes(endpoint, body, semantics)
        if expected == 'wire-calibration/v1:' + old:
            matches[digest(body)] = (new, body)
    if len(matches) != 1: raise ValueError('historical endpoint/model/format fingerprint does not match')
    request_id, (scope, body) = next(iter(matches.items()))
    # These are already disjoint, normalized Harness counters, NOT raw OpenAI usage.
    values = [usage.get(k, 0) for k in ('input_tokens', 'cache_read_tokens', 'cache_write_tokens')]
    if any(type(v) is not int or v < 0 for v in values): raise ValueError('invalid normalized usage')
    actual = sum(values)
    if not 0 < actual <= 10**12: raise ValueError('missing usage')
    f = features(body)
    return scope, {'request_id': request_id, 'features': f, 'actual': actual, 'observed_at_ms': timestamp}


def units(f): return max(1, sum(f['buckets']) + f['framing'])


def similar(a, b):
    x, y = units(a), units(b)
    return not a['image_tokens'] and not b['image_tokens'] and x / y <= 2 and y / x <= 2 and sum(abs(p/x-q/y) for p,q in zip(a['buckets'], b['buckets'])) < .30


def estimate(rows, f):
    selected = [r for r in rows if similar(r['features'], f)]
    if len(selected) < 8: return units(f)
    return math.ceil(units(f) * max(r['actual']/units(r['features']) for r in selected) * 1.25) + 256


def recover(journal, config, provider_id, model_id, semantics, now):
    profile = next(p for p in config['providers'] if p['id'] == provider_id)
    model = next(m for m in profile['models'] if m['id'] == model_id)
    if profile.get('usage_input_semantics', 'auto') != semantics: raise ValueError('usage semantics confirmation mismatch')
    # Bound the journal in memory: hold only the latest 64 unambiguous pairs.
    pairs = collections.deque(maxlen=64)
    pending = {}
    skipped = collections.Counter()
    with journal.open() as f:
        for line in f:
            for e in json.loads(line).get('events', []):
                t, d = e['event']['type'], e['event']['data']
                if t == 'request/header':
                    h = d['header'];measurement = h.get('options', {}).get('measurement', {})
                    key = (measurement.get('turn'), measurement.get('step'))
                    if None in key: continue
                    # Repeated header within one model step: response association is ambiguous.
                    pending[key] = None if key in pending else (h, e['seq'])
                elif t == 'assistant/message' and d.get('usage'):
                    item = pending.pop((d.get('turn'), d.get('step')), None)
                    if item and item[0].get('provider') == provider_id and item[0].get('model') == model_id:
                        pairs.append((item[0], d['usage'], e['timestamp_ms']))
                elif t in ('step/end', 'turn/end'):
                    pending.clear()
    scopes_out = {}
    latest = None
    for header, usage, timestamp in pairs:
        try:
            messages, tools = expand(journal.parent/'request-audit', header)
            scope, row = sample(header, messages, tools, usage, timestamp, profile, model, semantics, now)
            rows = scopes_out.setdefault(scope, [])
            if any(r['request_id'] == row['request_id'] for r in rows): continue
            if len([r for r in rows if similar(r['features'], row['features'])]) >= 8 and row['actual'] > estimate(rows, row['features']):
                rows.clear()
            rows.append(row);del rows[:-32]
            latest = (scope, row)
        except (ValueError, KeyError, TypeError, OSError):
            skipped['unverifiable'] += 1
    if not latest: raise ValueError('no verifiable samples')
    scope, row = latest
    if sum(similar(r['features'], row['features']) for r in scopes_out[scope]) < 8:
        raise ValueError('not enough comparable verified samples')
    snapshot = {'version': 1, 'scopes': scopes_out}
    report = {'samples': sum(map(len, scopes_out.values())), 'scopes': len(scopes_out), 'skipped': dict(skipped), 'last_actual': row['actual'], 'last_cold_estimate': units(row['features']), 'last_recovered_estimate': estimate(scopes_out[scope], row['features'])}
    return snapshot, report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--journal', type=Path, required=True)
    p.add_argument('--providers', type=Path, required=True)
    p.add_argument('--provider', required=True)
    p.add_argument('--model', required=True)
    p.add_argument('--confirm-legacy-usage-semantics', choices=['auto', 'total_includes_cache', 'uncached_input'], required=True)
    p.add_argument('--output', type=Path, required=True, help='NEW candidate file; no overwrite, do not use the running Host state path')
    args = p.parse_args()
    cache, report = recover(args.journal, json.loads(args.providers.read_text()), args.provider, args.model, args.confirm_legacy_usage_semantics, int(time.time()*1000))
    data = canonical(cache)
    if len(data) > 2*1024*1024: raise ValueError('cache too large')
    fd = os.open(args.output, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data);f.flush();os.fsync(f.fileno())
    print(json.dumps(report))

if __name__ == '__main__': main()
