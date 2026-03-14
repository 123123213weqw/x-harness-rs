import unittest
from environment_preflight import grade_evidence


class EvidenceTests(unittest.TestCase):
    def test_reward_zero_without_tests_is_not_failure_score(self):
        self.assertEqual(grade_evidence(0, None)['status'], 'INFRA_ERROR')

    def test_no_tests_collected(self):
        self.assertEqual(grade_evidence(0, {'results': {'tests': []}})['status'], 'INFRA_ERROR')

    def test_assertion_failures_are_valid(self):
        evidence = {'results': {'tests': [{'status': 'failed'}]}}
        self.assertEqual(grade_evidence(0, evidence)['status'], 'FAIL')

    def test_errors_and_reward_disagreement_fail_closed(self):
        for reward, statuses in [(1, ['failed']), (0, ['passed']), (0, ['other']), (1, ['skipped'])]:
            with self.subTest(reward=reward, statuses=statuses):
                evidence = {'results': {'tests': [{'status': status} for status in statuses]}}
                self.assertEqual(grade_evidence(reward, evidence)['status'], 'INFRA_ERROR')

    def test_real_pass(self):
        self.assertEqual(grade_evidence(1, {'results': {'tests': [{'status': 'passed'}]}})['status'], 'PASS')

    def test_malformed_evidence_fails_closed(self):
        for evidence in ([], 'text', {'results': None}, {'results': []},
                         {'results': {'tests': None}}, {'results': {'tests': {}}},
                         {'results': {'tests': [None]}}, {'results': {'tests': ['passed']}}):
            with self.subTest(evidence=evidence):
                self.assertEqual(grade_evidence(1, evidence)['status'], 'INFRA_ERROR')
        evidence = {'results': {'tests': [{'status': 'passed'}]}}
        for reward in (True, '1', float('nan')):
            with self.subTest(reward=reward):
                self.assertEqual(grade_evidence(reward, evidence)['status'], 'INFRA_ERROR')
