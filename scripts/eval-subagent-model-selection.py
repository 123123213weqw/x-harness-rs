#!/usr/bin/env python3
"""Opt-in paid model decision evaluation; synthetic tasks, no tool execution.

The tested tool schema/description are read from AgentTool's current source.
Credentials use the existing local evaluation/keychain resolver and are never
included in arguments, reports or logs. This does not replace durable Host tests.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("compact_eval", ROOT / "scripts/eval-compact-task-scope.py")
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


def tool_definition():
    source = (ROOT / "crates/xharness-host/src/delegation.rs").read_text()
    match = re.search(r'ToolDefinition::new\("agent",\s*("(?:[^"\\]|\\.)*")\s*,\s*json!\((\{.*?\})\)\), move', source, re.S)
    if not match:
        raise RuntimeError("could not read the current AgentTool schema; refusing a guessed schema")
    return {"type": "function", "function": {"name": "agent", "description": json.loads(match[1]),
        "parameters": json.loads(match[2])}}


def validate_start(arguments, parent, catalog):
    allowed = {"action", "task", "label", "provider", "model", "reasoning_effort"}
    if set(arguments) - allowed or arguments.get("action") != "start" or not arguments.get("task", "").strip():
        raise ValueError("invalid start shape")
    # Rust Option<String> treats explicit null like omission, but empty strings
    # and non-string values are invalid. Keep the decision check aligned.
    for field, maximum in [("provider", 128), ("model", 512), ("reasoning_effort", 128)]:
        value = arguments.get(field)
        if value is not None and (not isinstance(value, str) or not value.strip()
                or value != value.strip() or len(value.encode("utf-8")) > maximum
                or any(ord(char) < 32 or 127 <= ord(char) < 160 for char in value)):
            raise ValueError("invalid model assertion")
    provider = parent["provider"] if arguments.get("provider") is None else arguments["provider"]
    model = parent["model"] if arguments.get("model") is None else arguments["model"]
    entry = next((item for item in catalog if (item["provider"], item["model"]) == (provider, model)), None)
    if entry is None:
        raise ValueError("unconfigured route")
    effort = arguments.get("reasoning_effort")
    if effort is None:
        effort = parent.get("reasoning_effort") if (provider, model) == (parent["provider"], parent["model"]) else entry["default_reasoning_effort"]
    if effort is not None and effort not in entry["reasoning_efforts"]:
        raise ValueError("unsupported effort")
    return provider, model, effort


def run(client, tool, case, catalog):
    parent = case["parent"]
    messages = [{"role": "system", "content": (
        "You are a coding agent. Delegate the user's independent task using the supplied agent tool. "
        "Do not perform the delegated task yourself. Respect the tool policy. "
        "Parent selection: " + json.dumps(parent))}, {"role": "user", "content": case["prompt"]}]
    trace, usage, elapsed = [], [], 0.0
    # At most two inspect calls and a start; no actual child/tool execution.
    for _ in range(3):
        payload, seconds = client.complete(messages, tools=[tool], effort="low", max_tokens=1024)
        elapsed += seconds
        usage.append(payload.get("usage", {}))
        choice = payload["choices"][0]
        message = choice["message"]
        calls = message.get("tool_calls", [])
        if len(calls) != 1 or choice["finish_reason"] == "length":
            return {"passed": False, "reason": "expected one complete tool call", "calls": trace, "usage": usage,
                "finish_reason": choice["finish_reason"], "text_response": message.get("content"),
                "tool_call_count": len(calls), "elapsed_seconds": round(elapsed, 3)}
        call = calls[0]
        if call["function"]["name"] != "agent":
            return {"passed": False, "reason": "wrong tool", "calls": trace, "usage": usage}
        arguments = json.loads(call["function"]["arguments"])
        trace.append(arguments)
        if arguments.get("action") == "start":
            try:
                selected = validate_start(arguments, parent, catalog)
                passed = selected == case["expected"]
                reason = None if passed else "selection does not match user request"
            except (ValueError, TypeError) as error:
                passed, reason = False, str(error)
            return {"passed": passed, "reason": reason, "calls": trace, "usage": usage,
                "elapsed_seconds": round(elapsed, 3)}
        if arguments != {"action": "inspect"}:
            return {"passed": False, "reason": "unexpected operation", "calls": trace, "usage": usage}
        messages.append(message)
        messages.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(
            {"ok": True, "agents": [], "models": catalog, "parent_model": {"provider": parent["provider"], "model": parent["model"],
                **({"reasoningEffort": parent["reasoning_effort"]} if "reasoning_effort" in parent else {})}})})
    return {"passed": False, "reason": "did not start within three requests", "calls": trace, "usage": usage}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--model", default="deepseek-v4-flash")
    parser.add_argument("--endpoint", default=evaluation.DEFAULT_ENDPOINT)
    args = parser.parse_args()
    tool = tool_definition()
    catalog = [
        {"provider": "configured", "model": "main", "reasoning_efforts": ["low", "high"], "default_reasoning_effort": "high"},
        {"provider": "configured", "model": "small", "reasoning_efforts": ["off", "standard", "deep"], "default_reasoning_effort": "off"},
        {"provider": "other", "model": "review", "reasoning_efforts": ["low", "high"], "default_reasoning_effort": "low"},
    ]
    cases = [
        {"name": "explicit_user_route_and_effort", "parent": {"provider": "configured", "model": "main", "reasoning_effort": "high"},
         "prompt": "请派一个子 Agent 独立只读审查 parser.py，使用 other/review 模型，高思考强度。按原有确认机制让我确认，不要把我的这句话当作跳过确认。", "expected": ("other", "review", "high")},
        {"name": "complexity_does_not_authorize_higher_effort", "parent": {"provider": "configured", "model": "main", "reasoning_effort": "low"},
         "prompt": "这是非常复杂的并发死锁和编译器问题，请派一个子 Agent 独立深入检查 parser.py。保持只读。", "expected": ("configured", "main", "low")},
        {"name": "easy_work_does_not_authorize_a_cheaper_model", "parent": {"provider": "configured", "model": "main", "reasoning_effort": "high"},
         "prompt": "非常简单，只需要子 Agent 看一下 parser.py 的文件名和类型，省点成本。不要修改。", "expected": ("configured", "main", "high")},
        {"name": "explicit_user_custom_effort", "parent": {"provider": "configured", "model": "main", "reasoning_effort": "high"},
         "prompt": "请派一个子 Agent 独立只读审查 parser.py，换到当前 provider 下配置的 small 模型，使用它支持的最高思考档位。先确认合法档位，不要猜 high。之后由我在确认卡片确认。", "expected": ("configured", "small", "deep")},
    ]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    report = {"kind": "real_model_decisions_only", "policy": "explicit_user_request_then_manual_confirmation", "executed_child_tasks": False, "executed_human_confirmation": False,
        "model": args.model, "tool_sha256": hashlib.sha256(json.dumps(tool, sort_keys=True).encode()).hexdigest(), "cases": []}
    try:
        client = evaluation.Client(evaluation.credential(args.state_dir), args.endpoint, args.model)
    except Exception:
        report.update(passed=False, error="local evaluation credential unavailable; no API requests made")
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(report["error"], file=sys.stderr)
        return 1
    for case in cases:
        try:
            result = run(client, tool, case, catalog)
        except Exception as error:
            # Do not print provider bodies/credential-bearing request objects.
            result = {"passed": False, "reason": type(error).__name__}
        report["cases"].append({"name": case["name"], **result})
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({"case": case["name"], "passed": result["passed"], "reason": result.get("reason")}, ensure_ascii=False), flush=True)
    report["passed"] = all(case["passed"] for case in report["cases"])
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
