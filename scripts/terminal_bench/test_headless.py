import unittest
from headless import events, finished, exit_code


class HeadlessTests(unittest.TestCase):
    def test_timeout_is_distinct_from_adapter_failure(self):
        self.assertEqual(exit_code("settled"), 0)
        self.assertEqual(exit_code("timeout"), 124)
        self.assertEqual(exit_code("adapter_error"), 1)

    def test_wrapped_events(self):
        self.assertEqual(events({"events": [{"event": {"type": "turn/end"}}]}), [{"type": "turn/end"}])

    def test_wait_for_children(self):
        history = {"events": [{"type": "turn/end"}]}
        self.assertFalse(finished(history, {"items": [{"running": True}]}))
        self.assertTrue(finished(history, [{"running": False}]))
        self.assertFalse(finished({"events": []}, []))


if __name__ == "__main__":
    unittest.main()
