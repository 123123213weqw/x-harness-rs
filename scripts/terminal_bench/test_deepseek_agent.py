import json
import unittest
from unittest.mock import Mock, patch, call
from official_headless import provider_patch, launch_command, runtime_environment, stop_process_group


class OfficialTests(unittest.TestCase):
    def test_exited_leader_does_not_skip_child_cleanup(self):
        process = Mock(pid=123, **{'wait.return_value': 0})
        with patch('official_headless.os.killpg', create=True) as kill, \
                patch('official_headless.signal.SIGTERM', 15), \
                patch('official_headless.signal.SIGKILL', 9, create=True):
            stop_process_group(process)
            self.assertEqual(kill.call_args_list, [call(123, 15), call(123, 9)])

    def test_only_provider_budget_is_overridden(self):
        rows = provider_patch('http://127.0.0.1:123/v1', 65536, 16384)
        self.assertEqual([row['id'] for row in rows], ['llm-deepseek'])
        model = rows[0]['config']['models'][0]
        self.assertEqual(model['systemPromptUpdate'], 'in-history')
        self.assertEqual(model['inputModalities'], ['text', 'image'])
        self.assertEqual(model['contextWindow'], 65536)
        self.assertEqual(rows[0]['config']['maxTokens'], 16384)

    def test_task_is_one_argv_item_not_a_shell(self):
        task = 'fix test; $(not-a-command)'
        command = launch_command('/opt/official', '/tmp/patch.json', task)
        self.assertEqual(command[-1], task)
        self.assertIn('headless', command)
        self.assertNotIn('sdk-minimal', command)

    def test_no_ambient_keys_or_user_config(self):
        env = runtime_environment('/tmp/fixture', 'fake-capability', 'http://127.0.0.1:123/v1')
        self.assertEqual(env['DSH_HOME'], '/tmp/fixture/home')
        self.assertEqual(env['DEEPSEEK_API_KEY'], 'fake-capability')
        self.assertEqual(env['DSH_PERMISSION_MODE'], 'danger-full-access')
        self.assertEqual(env['DSH_TELEMETRY_MODE'], 'DISABLED')
        self.assertNotIn('fake-capability', json.dumps(provider_patch('http://127.0.0.1:123/v1', 65536, 16384)))
