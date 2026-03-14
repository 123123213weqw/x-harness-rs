"""Deterministic upstream substitute; native tools and Harbor grading stay real."""
import io
import json


class MockConnection:
    mode = 'normal'

    def __init__(self, host, timeout):
        if host != 'api.deepseek.com':
            raise ValueError('mock received unexpected destination')

    def request(self, method, path, body, headers):
        self.body = json.loads(body)

    def getresponse(self):
        body = self.body
        tools = {item['function']['name']: item['function'] for item in body.get('tools', [])}
        shell = next((name for name in tools if name.lower() == 'bash'), None)
        results = any(m['role'] == 'tool' for m in body['messages'])
        calls = None
        if shell and (not results or self.mode == 'budget'):
            command = 'printf ready > /app/fixture-ready'
            if self.mode == 'timeout':
                command += '; sleep 120'
            props = tools[shell]['parameters'].get('properties', {})
            arguments = {k: v for k, v in {'command': command, 'description': 'Create integration fixture marker'}.items() if k in props}
            calls = [{'index': 0, 'id': 'fixture-' + str(len(body['messages'])), 'type': 'function',
                      'function': {'name': shell, 'arguments': json.dumps(arguments)}}]
        delta = {'role': 'assistant', 'reasoning_content': 'Executing the fixture.'}
        delta.update({'tool_calls': calls} if calls else {'content': 'Fixture complete.'})
        usage = {'prompt_tokens': 10, 'completion_tokens': 5, 'prompt_cache_hit_tokens': 0}
        if body.get('stream'):
            items = [{'model': 'mock-deepseek-flash', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                     {'model': 'mock-deepseek-flash', 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if calls else 'stop'}], 'usage': usage}]
            data = ''.join('data: ' + json.dumps(item) + '\n\n' for item in items) + 'data: [DONE]\n\n'
        else:
            data = json.dumps({'model': 'mock-deepseek-flash', 'choices': [{'index': 0, 'message': delta,
                             'finish_reason': 'tool_calls' if calls else 'stop'}], 'usage': usage})
        response = io.BytesIO(data.encode())
        response.status = 200
        return response

    def close(self):
        pass
