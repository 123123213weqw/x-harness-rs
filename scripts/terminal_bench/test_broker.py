import json
import io
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from broker import Broker, BudgetError, Ledger, normalize


class BrokerTests(unittest.TestCase):
    def test_auth_and_expiry(self):
        ledger = Ledger()
        with self.assertRaises(PermissionError):
            ledger.reserve("wrong", 10)
        self.assertEqual(ledger.calls, 0)
        ledger.close()
        with self.assertRaises(PermissionError):
            ledger.reserve(ledger.token, 10)

    def test_failure_keeps_reservation_and_limits(self):
        ledger = Ledger(calls=1)
        amount = ledger.reserve(ledger.token, 100)
        ledger.settle(amount, None, 500, 1)
        self.assertEqual(ledger.spent, amount)
        with self.assertRaises(BudgetError):
            ledger.reserve(ledger.token, 100)
        tiny = Ledger(dollars=0.000001)
        with self.assertRaises(BudgetError):
            tiny.reserve(tiny.token, 10)

    def test_usage_accounting_and_redaction(self):
        ledger = Ledger()
        amount = ledger.reserve(ledger.token, 100)
        ledger.settle(amount, {"prompt_tokens": 100, "completion_tokens": 20}, 200, 1)
        report = ledger.close()
        self.assertLess(report["conservative_usd"], amount)
        self.assertNotIn(ledger.token, json.dumps(report))

    def test_fixed_settings(self):
        body = normalize({"model": "deepseek-flash", "messages": [], "max_tokens": 999999, "stream": True})
        self.assertEqual(body["max_tokens"], 4096)
        self.assertEqual(body["thinking"], {"type": "enabled"})
        self.assertTrue(body["stream_options"]["include_usage"])
        with self.assertRaises(ValueError):
            normalize({"model": "another-provider", "messages": []})

    def test_http_denies_before_network(self):
        broker = Broker("never-send-this-test-credential", "127.0.0.1")
        try:
            broker.ledger = Ledger()
            for suffix, status in [("/chat/completions", 403), ("/other", 404)]:
                request = urllib.request.Request(broker.url + suffix, data=json.dumps({"model": "deepseek-flash", "messages": []}).encode(), headers={"Content-Type": "application/json"})
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(request, timeout=3)
                self.assertEqual(error.exception.code, status)
                self.assertNotIn("never-send", error.exception.read().decode())
            self.assertEqual(broker.ledger.calls, 0)
        finally:
            broker.stop()

    def test_real_key_only_forwarded_upstream_and_usage_recorded(self):
        broker = Broker("upstream-test-secret", "127.0.0.1")
        try:
            broker.ledger = Ledger()
            response = io.BytesIO(b'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n')
            response.status = 200
            with patch("broker.http.client.HTTPSConnection") as connection:
                connection.return_value.getresponse.return_value = response
                request = urllib.request.Request(broker.url + "/chat/completions", data=json.dumps({"model": "deepseek-flash", "messages": [], "stream": True}).encode(), headers={"Authorization": "Bearer " + broker.ledger.token})
                with urllib.request.urlopen(request, timeout=3) as result:
                    body = result.read().decode()
                self.assertNotIn("upstream-test-secret", body)
                args = connection.return_value.request.call_args.args
                self.assertEqual(args[0:2], ("POST", "/chat/completions"))
                self.assertEqual(args[3]["Authorization"], "Bearer upstream-test-secret")
                self.assertEqual(json.loads(args[2])["max_tokens"], 4096)
            # HTTP connection closes after settlement in the handler's finally.
            self.assertEqual(broker.ledger.close()["rows"][0]["usage"]["completion_tokens"], 5)
        finally:
            broker.stop()


if __name__ == "__main__":
    unittest.main()
