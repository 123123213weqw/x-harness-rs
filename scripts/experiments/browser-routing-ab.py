#!/usr/bin/env python3
"""Opt-in live-model routing A/B; tools are simulated, never OS/browser actions.

Uses production prompt strings, MCP schema, native read/open schemas and a supplied
public tool-definition snapshot. No chat bodies, memories or hidden reasoning are
saved or sent. This measures route selection, NOT native rendering or task success.
"""
import argparse
import concurrent.futures
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
STATE = 'crates/xharness-host/src/state.rs'
MCP = 'crates/xharness-host-app/src/plugin_mcp.rs'
NATIVE = 'crates/xharness-host-app/src/native_browser.rs'
ENDPOINT = 'https://api.deepseek.com/chat/completions'
URL = 'https://pages.tmall.com/wow/a/act/tmall/dailygroup/24732/25590/wupr'


def source(path, revision=None):
    if revision:
        return subprocess.check_output(['git', 'show', f'{revision}:{path}'], cwd=ROOT, text=True)
    return (ROOT / path).read_text()


def literal(text, marker):
    start = text.index(marker) + len(marker)
    return json.JSONDecoder().raw_decode(text[start:].lstrip())[0]


def contract(revision=None):
    state, mcp, native = (source(path, revision) for path in (STATE, MCP, NATIVE))
    marker = '"plugin_mcp",'
    tail = mcp[mcp.index(marker) + len(marker):]
    definition = {'name': 'plugin_mcp', 'description': json.JSONDecoder().raw_decode(tail.lstrip())[0],
                  'parameters': literal(tail, 'json!(')}
    policy = literal(state, 'let browser = ') if 'let browser = ' in state else ''
    base_system = '\n\n'.join([source('crates/xharness-host/prompts/default-agent.txt', revision).strip(),
                                literal(state, 'let workflow = '), literal(state, 'let background_jobs = ')])
    schemas = {}
    for name in ('control', 'observe'):
        marker = 'json!({"name":"' + name + '"'
        schemas[name] = literal(native[native.index(marker):], 'json!(')
    plugin, server = literal(native, 'const PLUGIN: &str = '), literal(native, 'const SERVER: &str = ')
    summary_marker = '"description":"Embedded browser:'
    summary = ''
    if summary_marker in mcp:
        summary = literal(mcp[mcp.index(summary_marker):], '"description":')
    return {'definition': definition, 'base_system': base_system, 'policy': policy,
            'schemas': schemas, 'plugin': plugin, 'server': server, 'summary': summary}


def cases():
    return [
        {'id': 'open_page', 'user': f'Open {URL} and tell me the page title.', 'route': 'browser'},
        {'id': 'look_at_link', 'user': f'{URL} can you look at this?', 'route': 'browser'},
        {'id': 'after_js_fetch', 'user': f'Look at {URL} and explain the activity.', 'route': 'browser', 'prefetch': True},
        {'id': 'interactive_page', 'user': f'Open {URL} and locate the registration button. Do not submit anything.', 'route': 'browser'},
        {'id': 'explicit_chrome', 'user': f'Open {URL} in Google Chrome, not the embedded browser.', 'route': 'external'},
        {'id': 'desktop_calculator', 'user': 'Inspect the Calculator desktop application, not a website.', 'route': 'desktop'},
        {'id': 'read_title_only', 'user': f'Read just the public page title of {URL}. Do not open a browser.', 'route': 'fetch'},
        {'id': 'unavailable_bridge', 'user': f'Can you read the page at {URL}?', 'route': 'fallback', 'available': False},
    ]


class World:
    def __init__(self, case, configuration):
        self.case, self.contract = case, configuration
        self.trace = []
        self.discovered = self.opened = self.observed = self.fetched = False
        self.wrong_route = False

    def call(self, name, arguments):
        row = {'tool': name, 'arguments': copy.deepcopy(arguments)}
        available = self.case.get('available', True)
        c = self.contract
        if name in ('computer', 'bash'):
            self.wrong_route |= self.case['route'] in ('browser', 'fallback', 'fetch')
            result = {'ok': True, 'fixture': 'route observed; no desktop or command executed'}
        elif name == 'web_fetch':
            self.fetched = True
            result = {'ok': True, 'status': 200, 'content': 'AI Hackathon', 'extracted_chars': 12, 'content_type': 'text/html'}
        elif name == 'plugin_mcp':
            action, plugin, server = (arguments.get(key) for key in ('action', 'plugin', 'server'))
            if action == 'list' and plugin is None:
                self.discovered = True
                result = {'plugins': ['builtin'] + ([c['plugin']] if available else [])}
                if c['summary']:
                    result['capabilities'] = [{'plugin': c['plugin'], 'server': c['server'], 'description': c['summary']}] if available else []
            elif plugin == c['plugin'] and not available:
                result = {'ok': False, 'error': 'native browser is unavailable'}
            elif plugin == c['plugin'] and action == 'list' and server is None:
                self.discovered = True
                result = {'servers': [c['server']]}
            elif plugin == c['plugin'] and server == c['server'] and action == 'list':
                self.discovered = True
                result = {'tools': [{'name': tool['name'], 'description': tool['description']} for tool in c['schemas'].values()]}
            elif plugin == c['plugin'] and server == c['server'] and action == 'describe':
                result = {'tool': c['schemas'].get(arguments.get('tool'), {})}
            elif plugin == c['plugin'] and server == c['server'] and action == 'call':
                tool, args = arguments.get('tool'), arguments.get('arguments', {})
                if tool == 'control' and args.get('action') == 'status':
                    self.discovered = True
                    result = {'available': True, 'bound': self.opened, 'tabs': []}
                elif tool == 'control' and args.get('action') == 'open' and args.get('url', '').startswith('https://'):
                    self.opened = True
                    result = {'ok': True, 'state': 'ready', 'url': args['url'], 'tab_id': 'fixture-tab', 'effect': 'applied'}
                elif tool == 'observe' and self.opened:
                    self.observed = True
                    result = {'text': 'AI Hackathon. Registration is open.', 'frame_id': 'b' * 32, 'nodes': [{'ref': 'n1', 'role': 'button', 'name': 'Register'}]}
                else:
                    result = {'ok': False, 'error': 'unsupported or not-yet-open fixture action'}
            else:
                result = {'ok': False, 'error': 'unknown fixture target'}
        else:
            result = {'ok': False, 'error': 'operation outside routing fixture'}
        row['result'] = copy.deepcopy(result)
        self.trace.append(row)
        return result

    def decisive(self):
        route = self.case['route']
        if self.wrong_route or self.observed:
            return True
        if route in ('external', 'desktop'):
            return any(row['tool'] in ('computer', 'bash') for row in self.trace)
        return route == 'fallback' and self.discovered and self.fetched or route == 'fetch' and self.fetched

    def score(self, finished=False):
        route = self.case['route']
        forbidden = self.wrong_route
        if route == 'browser':
            passed = self.discovered and self.opened and self.observed and not forbidden
        elif route == 'fetch':
            passed = self.fetched and not self.opened and not forbidden
        elif route == 'desktop':
            passed = any(row['tool'] == 'computer' for row in self.trace) and not self.opened
        elif route == 'external':
            passed = any(row['tool'] == 'computer' or row['tool'] == 'bash' and 'chrome' in str(row['arguments']).lower() for row in self.trace) and not self.opened
        else:
            passed = self.discovered and not self.opened and not forbidden and (self.fetched or finished)
        return {'passed': passed, 'wrong_desktop_fallback': forbidden, 'discovered': self.discovered,
                'opened': self.opened, 'observed': self.observed, 'scope': 'routing only, not rendered-page correctness'}



def wire_result(name, arguments, result):
    """Match the text envelopes consumed by the production provider adapter."""
    if name == 'plugin_mcp' and arguments.get('action') == 'call':
        result = {'isError': result.get('ok') is False,
                  'content': [{'type': 'text', 'text': json.dumps(result)}]}
    failed = result.get('isError') is True
    return json.dumps({'ok': not failed, 'content': '' if failed else json.dumps(result),
                       'error': 'MCP tool reported failure: ' + json.dumps(result) if failed else '',
                       'truncated': False})


def credential(state_dir):
    if value := os.environ.get('XHARNESS_EVAL_API_KEY'):
        return value
    service = 'com.xlang.xharness.models.' + hashlib.sha256(str(state_dir.resolve()).encode()).hexdigest()
    result = subprocess.run(['security', 'find-generic-password', '-s', service, '-a', 'XHARNESS_DEEPSEEK_ONLY_KEY', '-w'], capture_output=True, text=True)
    if result.returncode or not result.stdout.strip():
        raise RuntimeError('Set XHARNESS_EVAL_API_KEY; no existing evaluation credential was available')
    return result.stdout.strip()


class Client:
    def __init__(self, key, model):
        self.key, self.model = key, model

    def complete(self, messages, tools):
        body = {'model': self.model, 'messages': messages, 'tools': tools, 'tool_choice': 'auto',
                'stream': False, 'temperature': 0, 'max_tokens': 1024, 'thinking': {'type': 'disabled'}}
        request = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), headers={
            'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
        start = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'provider HTTP {error.code}') from None
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError('provider transport failure') from None
        return result, round(time.monotonic() - start, 3)


def trial(client, case, arm, repeat, configuration, tool_snapshot):
    tools = copy.deepcopy(tool_snapshot)
    for definition in tools:
        if definition['function']['name'] == 'plugin_mcp':
            definition['function'] = configuration['definition']
    system = configuration['base_system'] + ('\n\n' + configuration['policy'] if configuration['policy'] else '')
    messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': case['user']}]
    if case.get('prefetch'):
        messages.extend([{'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'prior-fetch', 'type': 'function', 'function': {'name': 'web_fetch', 'arguments': json.dumps({'url': URL})}}]},
                         {'role': 'tool', 'tool_call_id': 'prior-fetch', 'content': wire_result('web_fetch', {'url': URL}, {'status': 200, 'content': 'AI Hackathon', 'extracted_chars': 12})}])
    world, requests, finished, error, answer = World(case, configuration), [], False, None, ''
    for _ in range(8):
        try:
            payload, elapsed = client.complete(messages, tools)
            choice = payload['choices'][0]
            wire = choice['message']
            requests.append({'elapsed_seconds': elapsed, 'usage': payload.get('usage', {}),
                             'response_model': payload.get('model'), 'finish_reason': choice.get('finish_reason')})
            calls = wire.get('tool_calls') or []
            # Preserve reasoning only in transient API continuation, never evidence files.
            messages.append(wire)
            if not calls:
                finished = choice.get('finish_reason') == 'stop'
                answer = wire.get('content') or ''
                break
            for call in calls:
                arguments = json.loads(call['function']['arguments'])
                if not isinstance(arguments, dict):
                    raise ValueError('tool arguments must be an object')
                result = world.call(call['function']['name'], arguments)
                messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': wire_result(call['function']['name'], arguments, result)})
            if world.decisive():
                break
        except RuntimeError as exc:
            error = str(exc)
            break
        except (KeyError, ValueError, TypeError):
            error = 'invalid provider/tool response'
            break
    score = world.score(finished)
    if error:
        score['passed'] = False
    return {'case': case['id'], 'arm': arm, 'repeat': repeat, 'score': score, 'infrastructure_error': error,
            'trace': world.trace, 'requests': requests, 'answer': answer}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tool-snapshot', type=Path, required=True, help='Public tool definitions only, not messages or credentials')
    parser.add_argument('--base', required=True)
    parser.add_argument('--repeats', type=int, choices=range(1, 5), default=2)
    parser.add_argument('--model', default='deepseek-flash')
    parser.add_argument('--state-dir', type=Path, default=Path.home() / 'Library/Application Support/com.xlang.xharness/state')
    args = parser.parse_args()
    definitions = json.loads(args.tool_snapshot.read_text())
    tools = [{'type': 'function', 'function': definition} for definition in definitions]
    assert {'plugin_mcp', 'computer', 'web_fetch', 'bash'} <= {t['function']['name'] for t in tools}
    before, after = contract(args.base), contract()
    assert not before['policy'] and after['policy'] and after['summary']
    assert before['definition']['parameters'] == after['definition']['parameters']
    args.output.mkdir(parents=True, exist_ok=False)
    protocol = {'base': args.base, 'model': args.model, 'endpoint': ENDPOINT, 'repeats': args.repeats,
                'max_steps': 8, 'max_output_tokens': 1024, 'thinking': 'disabled', 'concurrency': 3,
                'cases': cases(), 'before': before, 'after': after, 'tool_snapshot_sha256': hashlib.sha256(args.tool_snapshot.read_bytes()).hexdigest(),
                'scope': 'Real model, production strings/schema, simulated tool results. No native rendering or end-to-end GUI claim.',
                'fixture_version': 3, 'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'source_sha256': {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in (STATE, MCP, NATIVE)}}
    (args.output / 'protocol.json').write_text(json.dumps(protocol, indent=2))
    client, rows = Client(credential(args.state_dir), args.model), []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        jobs = [executor.submit(trial, client, case, arm, repeat, configuration, tools)
                for repeat in range(1, args.repeats + 1) for case in cases()
                for arm, configuration in ([('baseline', before), ('candidate', after)] if repeat % 2 else [('candidate', after), ('baseline', before)])]
        for job in concurrent.futures.as_completed(jobs):
            row = job.result()
            rows.append(row)
            (args.output / f"{row['case']}-{row['arm']}-{row['repeat']}.json").write_text(json.dumps(row, indent=2))
            print(json.dumps({key: row[key] for key in ('case', 'arm', 'repeat', 'score', 'infrastructure_error')}), flush=True)
    summary = {'scope': protocol['scope'], 'arms': {}}
    for arm in ('baseline', 'candidate'):
        selected = [row for row in rows if row['arm'] == arm]
        summary['arms'][arm] = {'passed': sum(row['score']['passed'] for row in selected), 'total': len(selected),
            'infrastructure_errors': sum(bool(row['infrastructure_error']) for row in selected),
            'wrong_desktop_fallbacks': sum(row['score']['wrong_desktop_fallback'] for row in selected),
            'requests': sum(len(row['requests']) for row in selected),
            'usage': {key: sum(request['usage'].get(key, 0) for row in selected for request in row['requests']) for key in ('prompt_tokens', 'completion_tokens', 'total_tokens')}}
    (args.output / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
