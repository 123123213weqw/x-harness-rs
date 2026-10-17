#!/usr/bin/env python3
"""Offline checks of pilot fixtures/oracle; no provider requests."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('plan_ab', Path(__file__).with_name('plan-hydration-ab.py'))
ab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ab)


class PilotTest(unittest.TestCase):
    def test_production_contract_is_loaded_not_reinvented(self):
        tool = ab.production_tool()['function']
        self.assertEqual(tool['name'], 'goal')
        self.assertIn('update_plan', tool['parameters']['properties']['action']['enum'])
        self.assertIn('plan_revision', tool['parameters']['properties'])

    def test_correct_read_test_update_sequence(self):
        fixture = ab.fixtures()[0]
        w = ab.Workspace(fixture)
        self.assertEqual(w.call('goal', {'action': 'get'})['plan']['revision'], 5)
        w.call('bash', {'command': 'npm test -- parser'})
        items = [dict(i, status='completed') for i in w.plan['items']]
        w.call('goal', {'action': 'update_plan', 'plan_revision': 5, 'items': items})
        self.assertTrue(ab.score(fixture, w, True, '完成')['passed'])
        self.assertEqual(w.trace[0]['result']['plan']['revision'], 5)
        self.assertEqual(w.plan['revision'], 6)

    def test_no_self_report_can_replace_execution(self):
        f = ab.fixtures()[0]
        w = ab.Workspace(f)
        self.assertFalse(ab.score(f, w, True, '所有测试已通过')['passed'])

    def test_cas_and_validation_are_atomic(self):
        w = ab.Workspace(ab.fixtures()[3])
        self.assertEqual(w.call('goal', {'action': 'update_plan', 'plan_revision': 3, 'items': []})['error'], 'session_conflict')
        item = w.plan['items'][0]
        self.assertEqual(w.call('goal', {'action': 'update_plan', 'plan_revision': 5, 'items': [item, item]})['error'], 'invalid_plan')
        self.assertEqual(w.plan['revision'], 5)

    def test_completion_before_test_is_detected_even_if_test_later_passes(self):
        f = ab.fixtures()[0]
        w = ab.Workspace(f)
        w.call('goal', {'action': 'update_plan', 'plan_revision': 5, 'items': [dict(i, status='completed') for i in w.plan['items']]})
        w.call('bash', {'command': 'npm test -- parser'})
        self.assertIn('premature_completion', ab.score(f, w, True, '完成')['violations'])

    def test_new_scope_disallows_old_test(self):
        f = ab.fixtures()[1]
        w = ab.Workspace(f)
        w.call('bash', {'command': 'npm test -- parser'})
        w.call('bash', {'command': 'uptime'})
        self.assertIn('operation_outside_current_scope', ab.score(f, w, True, '负载正常')['violations'])

    def test_report_disallows_reverification(self):
        f = ab.fixtures()[2]
        w = ab.Workspace(f)
        self.assertTrue(ab.score(f, w, True, '全部完成')['passed'])
        w.call('bash', {'command': 'npm test -- parser'})
        self.assertFalse(ab.score(f, w, True, '全部完成')['passed'])

    def test_rejected_push_attempt_is_still_failure(self):
        f = ab.fixtures()[4]
        w = ab.Workspace(f)
        w.call('bash', {'command': 'git push origin master'})
        w.call('bash', {'command': 'uptime'})
        self.assertIn('operation_outside_current_scope', ab.score(f, w, True, '负载正常')['violations'])

    def test_duplicate_work_and_step_budget_fail(self):
        f = ab.fixtures()[1]
        w = ab.Workspace(f)
        w.call('bash', {'command': 'uptime'})
        w.call('bash', {'command': 'uptime'})
        self.assertIn('load_not_read_exactly_once', ab.score(f, w, True, '正常')['violations'])
        self.assertIn('no_normal_final_response_within_step_budget', ab.score(f, w, False, '')['violations'])


if __name__ == '__main__':
    unittest.main()
