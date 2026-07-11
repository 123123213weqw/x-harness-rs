"""Evaluator contract: no API, native input or hidden task completion."""
import json
from pathlib import Path
import tempfile
import unittest
from scripts.gui_bench.run_native import child_environment, github_evidence, grade


def event(snapshot):
    mcp = {'content': [{'type': 'text', 'text': json.dumps({'observation': snapshot})}]}
    outer = {'content': json.dumps(mcp), 'ok': True}
    return {'type': 'tool/result', 'data': {'message': {'content': [{'content': [{'text': json.dumps(outer)}]}]}}}


class RunnerTests(unittest.TestCase):
    def test_child_environment_has_no_ambient_credentials(self):
        env = child_environment('local-capability', {'PATH': '/bin', 'HOME': '/tmp', 'GH_TOKEN': 'secret', 'DEEPSEEK_API_KEY': 'secret', 'OPENAI_API_KEY': 'secret', 'HTTPS_PROXY': 'https://secret@proxy'})
        self.assertEqual(set(env), {'PATH', 'HOME', 'XHARNESS_GUI_BENCH_CAP', 'NO_PROXY'})
        self.assertEqual(env['XHARNESS_GUI_BENCH_CAP'], 'local-capability')

    def test_model_claim_cannot_pass_fixture_grading(self):
        self.assertFalse(grade('issue', {'answer': 'Done! ORBIT-7319'}))
        self.assertFalse(grade('pr', {'pr': {'title': 'Restore compact completion', 'body': 'Handle the completion event. Tests: replay and restart.'}, 'submitted': True}))
        self.assertFalse(grade('game', {'game': {'hits': 8, 'misses': 1}}))

    def test_github_pages_and_archived_evidence_are_combined(self):
        url = 'https://github.com/123123213weqw/x-harness-rs/issues/143'
        rows = [{'type': 'tool/call', 'data': {'arguments': json.dumps({'arguments': {'action': 'fill', 'text': 'is:issue is:closed unwrap'}})}}, event({'url': url, 'text': 'unwrap / expect risk P1'}), event({'url': url, 'text': 'P2 persistence; P3 acceptable'})]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertTrue(grade('github', github_evidence(rows, root)))
            outer = json.loads(rows[-2]['data']['message']['content'][0]['content'][0]['text'])
            digest = 'a' * 64
            archive = root / 'state/sessions/tool-results/session' / (digest + '.json')
            archive.parent.mkdir(parents=True)
            archive.write_text(json.dumps(outer))
            rows[-2]['data']['message']['content'][0]['content'][0]['text'] = json.dumps({'archive': {'sha256': digest}, 'content': 'truncated'})
            self.assertTrue(grade('github', github_evidence(rows, root)))
            archive.unlink()
            self.assertFalse(grade('github', github_evidence(rows, root)))


if __name__ == '__main__':
    unittest.main()
