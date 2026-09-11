import unittest
from headless import settled_status, exit_code


class NativeExitTests(unittest.TestCase):
    def test_inner_error_is_not_successful_native_completion(self):
        reason = {'kind': 'error', 'error': {'code': 'LOOP_FAILED'}}
        self.assertEqual(exit_code(settled_status([reason])), 1)

    def test_normal_settlement_and_deadline_remain_distinct(self):
        self.assertEqual(exit_code(settled_status([{'kind': 'completed'}])), 0)
        self.assertEqual(exit_code('timeout'), 124)
