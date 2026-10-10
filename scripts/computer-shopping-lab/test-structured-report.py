import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from structured_report import (LocalChatTransport, ProviderFailure, ReportInvalid,
    StructuredReporter, decode_object, output_schema, parse_report, parse_terminal,
    response_text, terminal_schema, validate_schema)

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("oracle", ROOT / "grade-expanded.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
spec = importlib.util.spec_from_file_location("runner", ROOT / "finalize-recorded-reports.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

PRODUCTS = [{"name": "Orion Pro SSD", "price": 549}, {"name": "Lyra Plus SSD", "price": 599}]
REPORT = {"products": PRODUCTS}
DETAIL = {"name": "Accessory 779", "price": 98, "returned": True}
EVENTS = [{"type": "initial", "scenario": "modal"},
          {"type": "dismiss_modal", "scenario": "modal"},
          {"type": "search", "scenario": "modal", "query": "SSD",
           "visible": ["orion", "lyra", "nova", "qlc", "short", "gen3", "weak", "small"]}]


def response(value, finish="stop", **extra):
    return {"choices": [{"finish_reason": finish, "message": {
        "role": "assistant", "content": json.dumps(value), **extra}}]}


def ok(value=REPORT):
    return response({"status": "ok", "report": value, "reason": ""})


class Fake:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.bodies = []

    def __call__(self, body):
        self.bodies.append(body)
        if body["response_format"]["json_schema"]["name"] == "report_schema_probe":
            return response({"price": 7})
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class Validation(unittest.TestCase):
    def test_all_case_schemas(self):
        for case, report in [("modal", REPORT), ("slow-layout", REPORT), ("scroll-detail", DETAIL),
                            ("filter", {"sorted_names": ["Orion Pro SSD"], "compared": PRODUCTS})]:
            with self.subTest(case=case):
                self.assertEqual(parse_report(case, json.dumps(report)), report)

    def test_currency_string_is_not_numeric_schema(self):
        value = json.loads(json.dumps(REPORT)); value["products"][0]["price"] = "CNY 549"
        with self.assertRaises(ReportInvalid): parse_report("modal", json.dumps(value))

    def test_boolean_is_not_price(self):
        with self.assertRaises(ReportInvalid): parse_report("scroll-detail", json.dumps({**DETAIL, "price": True}))

    def test_nonfinite_and_overflow(self):
        for price in ("NaN", "Infinity", "-Infinity", "1e999"):
            with self.subTest(price=price), self.assertRaises(ReportInvalid):
                parse_report("scroll-detail", '{"name":"a","price":'+price+',"returned":true}')

    def test_missing_and_extra_keys(self):
        for value in ({"products": []}, {**REPORT, "extra": 1}, {"products": [{"name": "a"}, PRODUCTS[1]]}):
            with self.subTest(value=value), self.assertRaises(ReportInvalid):
                parse_report("modal", json.dumps(value))

    def test_duplicate_keys(self):
        for text in ('{"a":1,"a":2}', '{"a":{"price":1,"price":2}}'):
            with self.assertRaises(ReportInvalid): decode_object(text)

    def test_prose_and_fence_are_not_silently_extracted(self):
        for text in ("Finished.\n"+json.dumps(REPORT), "```json\n"+json.dumps(REPORT)+"\n```"):
            with self.assertRaises(ReportInvalid): parse_report("modal", text)

    def test_ambiguous_two_objects(self):
        with self.assertRaises(ReportInvalid): parse_report("modal", json.dumps(REPORT)*2)

    def test_non_object_and_truncated(self):
        for text in ("null", "[]", "42", '{"products":'):
            with self.assertRaises(ReportInvalid): parse_report("modal", text)

    def test_negative_prices_and_empty_names(self):
        for value in ({**DETAIL, "price": -1}, {**DETAIL, "name": ""}):
            with self.assertRaises(ReportInvalid): parse_report("scroll-detail", json.dumps(value))

    def test_unknown_case_fails_closed(self):
        with self.assertRaises(ReportInvalid): output_schema("unknown")

    def test_unsupported_keyword_fails_closed(self):
        with self.assertRaises(ReportInvalid): validate_schema("a", {"type": "string", "pattern": "a"})

    def test_schema_copy_isolated(self):
        value = output_schema("modal"); value["properties"]["products"]["items"]["required"].clear()
        self.assertEqual(output_schema("modal")["properties"]["products"]["items"]["required"], ["name", "price"])

    def test_honest_abstention(self):
        value = {"status": "insufficient_data", "report": None, "reason": "Price was not read"}
        self.assertEqual(parse_terminal("modal", json.dumps(value)), value)

    def test_inconsistent_envelopes(self):
        for value in ({"status": "ok", "report": None, "reason": ""},
                      {"status": "ok", "report": REPORT, "reason": "unknown"},
                      {"status": "insufficient_data", "report": REPORT, "reason": "unknown"},
                      {"status": "insufficient_data", "report": None, "reason": ""},
                      {"status": "other", "report": None, "reason": "unknown"}):
            with self.subTest(value=value), self.assertRaises(ReportInvalid):
                parse_terminal("modal", json.dumps(value))


class Generation(unittest.TestCase):
    def reporter(self, sender): return StructuredReporter(sender, "test-model")

    def test_schema_applied_only_tool_free_final_stage(self):
        send = Fake(ok()); result = self.reporter(send).generate("modal", "Draft with prices: CNY 549, CNY 599")
        self.assertEqual(result["value"], REPORT)
        self.assertEqual(len(send.bodies), 2)  # One probe and one report.
        for body in send.bodies:
            self.assertFalse(set(body) & {"tools", "functions", "tool_choice", "function_call"})
            self.assertTrue(body["response_format"]["json_schema"]["strict"])
            self.assertFalse(body["stream"])

    def test_correct_original_needs_no_network(self):
        send = Fake(); result = self.reporter(send).generate("modal", json.dumps(REPORT))
        self.assertEqual(result["source"], "original"); self.assertFalse(send.bodies)

    def test_capability_cached_per_run(self):
        send = Fake(ok(), ok()); reporter = self.reporter(send)
        reporter.generate("modal", "a"); reporter.generate("slow-layout", "b")
        self.assertEqual(len(send.bodies), 3)

    def test_provider_ignoring_schema_not_admitted(self):
        calls = []
        def send(body): calls.append(body); return response("BAD")
        result = self.reporter(send).generate("modal", "a")
        self.assertEqual(result["status"], "unsupported"); self.assertEqual(len(calls), 1)

    def test_unsupported_probe_does_not_fall_back(self):
        calls = []
        def send(body): calls.append(body); raise ProviderFailure("unsupported response_format", 400)
        result = self.reporter(send).generate("modal", "a")
        self.assertEqual(result["status"], "unsupported"); self.assertEqual(len(calls), 1)

    def test_bounded_validation_repair_no_action_replay(self):
        send = Fake(response("bad"), ok()); result = self.reporter(send).generate("modal", "original draft")
        self.assertEqual(result["status"], "valid"); self.assertEqual(len(result["attempts"]), 2)
        data = json.loads(send.bodies[-1]["messages"][-1]["content"])
        self.assertEqual(data["draft"], "original draft"); self.assertTrue(data["validation_error"])
        self.assertFalse(result["native_actions_replayed"])

    def test_invalid_stops_after_two_reports(self):
        send = Fake(response("bad"), response("bad")); result = self.reporter(send).generate("modal", "a")
        self.assertEqual(result["status"], "invalid"); self.assertEqual(len(send.bodies), 3)

    def test_length_is_incomplete_even_if_json_looks_complete(self):
        send = Fake(response({"status": "ok", "report": REPORT, "reason": ""}, finish="length"), ok())
        result = self.reporter(send).generate("modal", "a")
        self.assertEqual(len(result["attempts"]), 2)

    def test_tool_call_is_rejected_never_dispatched(self):
        send = Fake(response({}, tool_calls=[{"function": {"name": "computer"}}]), ok())
        result = self.reporter(send).generate("modal", "a")
        self.assertEqual(result["status"], "valid")
        self.assertIn("nothing dispatched", result["attempts"][0]["validation_error"])

    def test_legacy_function_call_is_rejected(self):
        with self.assertRaises(ReportInvalid): response_text(response({}, function_call={"name": "computer"}))

    def test_refusal_is_not_success(self):
        with self.assertRaises(ReportInvalid): response_text(response({}, refusal="refused"))

    def test_malformed_provider_envelope(self):
        for value in ({}, {"choices": []}, {"choices": [None]}, response({}, content=None)):
            with self.assertRaises(ReportInvalid): response_text(value)

    def test_network_failure_not_retried(self):
        send = Fake(ProviderFailure("timeout")); result = self.reporter(send).generate("modal", "a")
        self.assertEqual(result["status"], "unavailable"); self.assertEqual(len(result["attempts"]), 1)

    def test_insufficient_facts_not_guessed_or_retried(self):
        send = Fake(response({"status": "insufficient_data", "report": None, "reason": "Price not read"}))
        result = self.reporter(send).generate("modal", "Unknown price")
        self.assertEqual(result["status"], "insufficient_data"); self.assertIsNone(result["value"])
        self.assertEqual(len(result["attempts"]), 1)

    def test_missing_and_oversized_drafts_do_not_request(self):
        for draft in (None, "", " "*5, "x"*65537):
            send = Fake(); result = self.reporter(send).generate("modal", draft)
            self.assertEqual(result["status"], "input_rejected"); self.assertFalse(send.bodies)

    def test_loopback_no_credentials(self):
        for endpoint in ("https://127.0.0.1/v1", "http://example.com/v1", "http://user:key@127.0.0.1/v1", "http://127.0.0.1/v1?key=a"):
            with self.assertRaises(ValueError): LocalChatTransport(endpoint)

    def test_transport_refuses_tools_before_network(self):
        with self.assertRaises(ReportInvalid): LocalChatTransport("http://127.0.0.1:1/v1")({"tools": []})


class SeparateGrades(unittest.TestCase):
    def test_format_failure_is_not_operation_failure(self):
        result = oracle.grade_separate("modal", "Finished. " + json.dumps(REPORT), EVENTS)
        self.assertTrue(result["operation_pass"]); self.assertFalse(result["format_pass"])
        self.assertIsNone(result["facts_pass"]); self.assertEqual(result["facts_status"], "not_evaluated")

    def test_currency_facts_correct_but_schema_wrong(self):
        text = json.dumps({"products": [{"name": p["name"], "price": "CNY " + str(p["price"])} for p in PRODUCTS]})
        result = oracle.grade_separate("modal", text, EVENTS)
        self.assertTrue(result["operation_pass"]); self.assertTrue(result["facts_pass"])
        self.assertFalse(result["format_pass"]); self.assertFalse(result["overall_pass"])

    def test_valid_schema_is_not_evidence_of_correct_facts(self):
        value = json.loads(json.dumps(REPORT)); value["products"][0]["price"] = 100
        result = oracle.grade_separate("modal", json.dumps(value), EVENTS)
        self.assertTrue(result["format_pass"]); self.assertFalse(result["facts_pass"])

    def test_no_external_operation_cannot_pass(self):
        result = oracle.grade_separate("modal", json.dumps(REPORT), EVENTS[:1])
        self.assertTrue(result["format_pass"]); self.assertFalse(result["operation_pass"])

    def test_unknown_effect_is_not_fixed_by_formatting(self):
        result = oracle.grade_separate("modal", json.dumps(REPORT), EVENTS, error="outcome unknown")
        self.assertFalse(result["operation_pass"]); self.assertFalse(result["overall_pass"])

    def test_true_success(self):
        self.assertTrue(oracle.grade_separate("modal", json.dumps(REPORT), EVENTS)["overall_pass"])

    def test_driver_writes_new_evidence_without_mutating_original(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            draft = "Finished. " + json.dumps(REPORT)
            (root/"draft.txt").write_text(draft)
            (root/"events.jsonl").write_text("\n".join(json.dumps(e) for e in EVENTS))
            (root/"summary.json").write_text(json.dumps({"case": "modal", "error": None, "source_sha": "source"}))
            manifest = {"base_url": "http://127.0.0.1:1/v1", "model": "test", "cases": [
                {"case": "modal", "draft": "draft.txt", "events": "events.jsonl", "summary": "summary.json"}]}
            (root/"manifest.json").write_text(json.dumps(manifest))
            result = runner.run(root/"manifest.json", root/"new", Fake(ok()))
            self.assertEqual(result["overall_passed"], 1); self.assertFalse(result["gui_rerun"])
            self.assertEqual((root/"draft.txt").read_text(), draft)
            with self.assertRaises(FileExistsError): runner.run(root/"manifest.json", root/"new", Fake())

    def test_driver_operation_failure_never_enters_formatter(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root/"draft.txt").write_text("Finished. " + json.dumps(REPORT))
            (root/"events.jsonl").write_text("\n".join(json.dumps(e) for e in EVENTS))
            (root/"summary.json").write_text(json.dumps({"case": "modal", "error": "outcome unknown"}))
            (root/"manifest.json").write_text(json.dumps({"base_url": "http://127.0.0.1:1/v1", "model": "test", "cases": [
                {"case": "modal", "draft": "draft.txt", "events": "events.jsonl", "summary": "summary.json"}]}))
            send = Fake(); result = runner.run(root/"manifest.json", root/"new", send)
            self.assertFalse(send.bodies); self.assertEqual(result["overall_passed"], 0)

    def test_driver_formatting_failure_is_not_wrong_facts(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root/"draft.txt").write_text("Unknown price")
            (root/"events.jsonl").write_text("\n".join(json.dumps(e) for e in EVENTS))
            (root/"summary.json").write_text(json.dumps({"case": "modal", "error": None}))
            (root/"manifest.json").write_text(json.dumps({"base_url": "http://127.0.0.1:1/v1", "model": "test", "cases": [
                {"case": "modal", "draft": "draft.txt", "events": "events.jsonl", "summary": "summary.json"}]}))
            send = Fake(response({"status": "insufficient_data", "report": None, "reason": "Price unknown"}))
            result = runner.run(root/"manifest.json", root/"new", send)
            self.assertEqual(result["operation_passed"], 1); self.assertEqual(result["facts_passed"], 0)
            self.assertEqual(result["cases"][0]["after"]["facts_status"], "not_evaluated")


if __name__ == "__main__":
    unittest.main()
