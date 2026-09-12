"""Independent verifier evidence, separate from agent self-reported completion."""


def grade_evidence(reward, ctrf):
    results = ctrf.get('results') if isinstance(ctrf, dict) else None
    tests = results.get('tests') if isinstance(results, dict) else None
    if not isinstance(tests, list) or any(not isinstance(test, dict) for test in tests):
        return {'status': 'INFRA_ERROR', 'reason': 'malformed test evidence'}
    statuses = [test.get('status') for test in tests]
    if not statuses or any(status not in ('passed', 'failed', 'skipped') for status in statuses):
        return {'status': 'INFRA_ERROR', 'reason': 'missing or unsupported test evidence'}
    executed = [status for status in statuses if status != 'skipped']
    if not executed:
        return {'status': 'INFRA_ERROR', 'reason': 'no tests executed'}
    failed = executed.count('failed')
    if type(reward) not in (int, float) or reward not in (0, 1) or (reward == 1) != (failed == 0):
        return {'status': 'INFRA_ERROR', 'reason': 'reward disagrees with test evidence'}
    # A failed pytest case can itself contain an infrastructure error; consumers
    # must still review grader exceptions/logs. CTRF consistency is necessary,
    # not sufficient, evidence of a task's semantic correctness.
    return {'status': 'FAIL' if failed else 'PASS', 'executed': len(executed), 'failed': failed}
