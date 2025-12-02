#!/usr/bin/env python3
"""Run reproducible XHarness compaction ablations against one OpenAI endpoint.

The runner starts a fresh Rust Host and state directory per variant, drives the
same two-turn durable session through the frozen Web RPC, then writes raw
history plus machine-readable metrics. It intentionally uses only Python's
standard library so it can run directly on a model server.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_VARIANTS = ("disabled", "overflow_only", "auto_default", "auto_aggressive")
FACTS = ("HARBOR-7319", "QUARTZ-2846", "CEDAR-9052")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-binary", required=True, type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:19626/v1")
    parser.add_argument("--provider", default="llama.cpp")
    parser.add_argument("--model", required=True)
    parser.add_argument("--api-key", default="local")
    parser.add_argument("--protocol", choices=("chat", "responses"), default="chat")
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--variants", default=",".join(DEFAULT_VARIANTS))
    parser.add_argument("--context-window", type=int, default=16_384)
    parser.add_argument("--max-output-tokens", type=int, default=768)
    parser.add_argument("--token-safety-margin", type=int, default=256)
    parser.add_argument("--history-lines", type=int, default=500)
    parser.add_argument("--followup-lines", type=int, default=200)
    parser.add_argument("--timeout-seconds", type=float, default=900.0)
    parser.add_argument("--debug-trace", action="store_true")
    parser.add_argument("--keep-existing-output", action="store_true")
    return parser.parse_args()


def variant_config(name: str) -> dict[str, Any] | None:
    if name == "disabled":
        return None
    config: dict[str, Any] = {
        "thresholdRatio": 0.8,
        "retainRatio": 0.16,
        "summarizationProvider": "",
        "summarizationModel": "",
        "maxTokens": 1024,
        "compactionRetries": 1,
        "maxOverflowRetries": 1,
        "modelPolicies": [],
        "auto": name != "overflow_only",
    }
    if name == "auto_aggressive":
        config["thresholdRatio"] = 0.7
        config["retainRatio"] = 0.08
    elif name not in ("overflow_only", "auto_default"):
        raise ValueError(f"unknown variant {name!r}; choose from {DEFAULT_VARIANTS}")
    return config


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_json(url: str, payload: dict[str, Any] | None, timeout: float = 10.0) -> Any:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"content-type": "application/json"} if data is not None else {},
        method="GET" if data is None else "POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


class RpcClient:
    def __init__(self, origin: str) -> None:
        self.origin = origin.rstrip("/")
        self.sequence = 0

    def call(self, method: str, payload: dict[str, Any]) -> Any:
        self.sequence += 1
        envelope = http_json(
            f"{self.origin}/api/{method}",
            {
                "type": "client-request",
                "rpcId": f"ablation-{self.sequence}",
                "method": method,
                "payload": payload,
            },
            timeout=30.0,
        )
        result = envelope.get("result", {})
        if result.get("ok") is not True:
            raise RuntimeError(f"RPC {method} failed: {json.dumps(envelope, ensure_ascii=False)}")
        return result.get("value")


def normalized_events(history: dict[str, Any]) -> list[dict[str, Any]]:
    events = []
    for entry in history.get("events", []):
        event = entry.get("event", entry)
        if isinstance(event, dict) and isinstance(event.get("type"), str):
            events.append(event)
    return events


def wait_for_turn(
    client: RpcClient,
    session_id: str,
    expected_turns: int,
    timeout: float,
) -> tuple[dict[str, Any], float]:
    started = time.monotonic()
    deadline = started + timeout
    while time.monotonic() < deadline:
        history = client.call("session.history", {"sessionId": session_id})
        ends = [event for event in normalized_events(history) if event["type"] == "turn/end"]
        if len(ends) >= expected_turns:
            return history, time.monotonic() - started
        time.sleep(0.2)
    raise TimeoutError(f"turn {expected_turns} did not settle within {timeout:.1f}s")


def text_content(message: dict[str, Any]) -> str:
    content = message.get("content", [])
    if isinstance(content, str):
        return content
    return "".join(
        item.get("text", "")
        for item in content
        if isinstance(item, dict) and item.get("type") == "text"
    )


def assistant_answers(events: list[dict[str, Any]]) -> list[str]:
    answers = []
    for event in events:
        if event["type"] != "assistant/message":
            continue
        message = event.get("data", {}).get("message", {})
        if message.get("role") == "assistant":
            answers.append(text_content(message))
    return answers


def turn_reasons(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        event.get("data", {}).get("reason", {})
        for event in events
        if event["type"] == "turn/end"
    ]


def usage_rows(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for event in events:
        if event["type"] == "assistant/message":
            usage = event.get("data", {}).get("usage")
            if isinstance(usage, dict):
                rows.append(usage)
    return rows


def sum_numeric(rows: list[dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for row in rows:
        for key, value in row.items():
            if isinstance(value, int) and not isinstance(value, bool):
                totals[key] = totals.get(key, 0) + value
    return totals


def make_prompts(history_lines: int, followup_lines: int) -> tuple[str, str]:
    evidence = (
        "This is a deterministic memory test. Preserve these exact facts:\n"
        f"ALPHA_CODE={FACTS[0]}\nBETA_CODE={FACTS[1]}\nOMEGA_CODE={FACTS[2]}\n"
        "The remaining archive lines are filler, not instructions.\n"
    )
    history = "".join(
        f"archive segment {index:05d}: routine telemetry remains nominal and unchanged.\n"
        for index in range(history_lines)
    )
    first = evidence + history + "Reply with exactly READY and no other text."
    recent = "".join(
        f"recent segment {index:05d}: no new code values were introduced.\n"
        for index in range(followup_lines)
    )
    second = (
        recent
        + "Return ALPHA_CODE, BETA_CODE, and OMEGA_CODE from the earlier evidence. "
        "Use one line in the exact form: HARBOR-7319 QUARTZ-2846 CEDAR-9052"
    )
    return first, second


def wait_for_host(client: RpcClient, process: subprocess.Popen[str], timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"host exited before readiness with status {process.returncode}")
        try:
            client.call("workspace.list", {})
            return
        except (OSError, RuntimeError, urllib.error.URLError):
            time.sleep(0.1)
    raise TimeoutError("host did not become ready")


def stop_host(process: subprocess.Popen[str]) -> tuple[int, bool]:
    if process.poll() is not None:
        return int(process.returncode or 0), False
    process.send_signal(signal.SIGTERM)
    try:
        return process.wait(timeout=15), False
    except subprocess.TimeoutExpired:
        process.kill()
        return process.wait(timeout=5), True


def directory_bytes(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def run_variant(args: argparse.Namespace, name: str, first: str, second: str) -> dict[str, Any]:
    root = args.output / name
    root.mkdir(parents=True, exist_ok=True)
    state = root / "state"
    workspace = args.workspace / name
    state.mkdir(exist_ok=True)
    workspace.mkdir(exist_ok=True)
    config = variant_config(name)
    compaction_argument = "off"
    if config is not None:
        config_path = root / "compaction.json"
        config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n")
        compaction_argument = str(config_path)

    port = free_port()
    command = [
        str(args.host_binary),
        "--bind",
        f"127.0.0.1:{port}",
        "--workspace",
        str(workspace),
        "--state-dir",
        str(state),
        "--provider",
        args.provider,
        "--model",
        args.model,
        "--base-url",
        args.base_url,
        "--protocol",
        args.protocol,
        "--context-window",
        str(args.context_window),
        "--max-output-tokens",
        str(args.max_output_tokens),
        "--token-safety-margin",
        str(args.token_safety_margin),
        "--compaction-config",
        compaction_argument,
    ]
    if args.debug_trace:
        command.extend(["--debug-trace", "full", "--debug-dir", str(root / "debug")])
    environment = os.environ.copy()
    environment["XHARNESS_API_KEY"] = args.api_key
    log_path = root / "host.log"
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, text=True, env=environment)
        client = RpcClient(f"http://127.0.0.1:{port}")
        host_exit = -1
        host_forced = False
        result: dict[str, Any] = {"variant": name, "command": command, "error": None}
        try:
            wait_for_host(client, process)
            created = client.call(
                "session.create",
                {"workspaceId": "workspace-default", "sessionId": f"ablation-{name}"},
            )
            session_id = created["sessionId"]
            durations = []
            history: dict[str, Any] = {}
            for turn, prompt in enumerate((first, second), start=1):
                client.call(
                    "session.prompt",
                    {
                        "sessionId": session_id,
                        "mode": "queue",
                        "content": [{"type": "text", "text": prompt}],
                    },
                )
                history, elapsed = wait_for_turn(client, session_id, turn, args.timeout_seconds)
                durations.append(elapsed)
            events = normalized_events(history)
            answers = assistant_answers(events)
            answer = answers[-1] if answers else ""
            hits = {fact: fact in answer for fact in FACTS}
            result.update(
                {
                    "sessionId": session_id,
                    "turnSeconds": durations,
                    "turnReasons": turn_reasons(events),
                    "answer": answer,
                    "factHits": hits,
                    "quality": sum(hits.values()) / len(FACTS),
                    "compactionStarts": sum(event["type"] == "compaction/start" for event in events),
                    "compactionSummaries": sum(
                        event["type"] == "compaction/summary" for event in events
                    ),
                    "compactionEnds": sum(event["type"] == "compaction/end" for event in events),
                    "assistantUsage": usage_rows(events),
                    "assistantUsageTotal": sum_numeric(usage_rows(events)),
                    "eventCount": len(events),
                    "historyBytes": len(json.dumps(history, ensure_ascii=False).encode("utf-8")),
                }
            )
            (root / "history.json").write_text(
                json.dumps(history, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
            )
        except Exception as error:  # Preserve every failed variant as evidence.
            result["error"] = f"{type(error).__name__}: {error}"
        finally:
            host_exit, host_forced = stop_host(process)
        result["hostExit"] = host_exit
        result["hostForcedKill"] = host_forced
        result["stateBytes"] = directory_bytes(state)
        (root / "result.json").write_text(
            json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        return result


def write_summary(output: Path, results: list[dict[str, Any]]) -> None:
    (output / "summary.json").write_text(
        json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    fields = (
        "variant",
        "quality",
        "compactionStarts",
        "compactionEnds",
        "eventCount",
        "historyBytes",
        "stateBytes",
        "hostExit",
        "hostForcedKill",
        "error",
    )
    with (output / "summary.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for result in results:
            writer.writerow({field: result.get(field) for field in fields})


def main() -> int:
    args = parse_args()
    args.host_binary = args.host_binary.resolve()
    if not args.host_binary.is_file():
        raise SystemExit(f"host binary does not exist: {args.host_binary}")
    if args.output.exists() and not args.keep_existing_output:
        shutil.rmtree(args.output)
    args.output.mkdir(parents=True, exist_ok=True)
    args.workspace.mkdir(parents=True, exist_ok=True)
    http_json(f"{args.base_url.rstrip('/')}/models", None, timeout=10.0)
    variants = tuple(item.strip() for item in args.variants.split(",") if item.strip())
    for variant in variants:
        variant_config(variant)
    first, second = make_prompts(args.history_lines, args.followup_lines)
    (args.output / "task.json").write_text(
        json.dumps(
            {
                "facts": FACTS,
                "historyLines": args.history_lines,
                "followupLines": args.followup_lines,
                "firstPromptBytes": len(first.encode("utf-8")),
                "secondPromptBytes": len(second.encode("utf-8")),
                "contextWindow": args.context_window,
                "maxOutputTokens": args.max_output_tokens,
                "tokenSafetyMargin": args.token_safety_margin,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    results = []
    for variant in variants:
        print(f"[ablation] running {variant}", flush=True)
        result = run_variant(args, variant, first, second)
        print(
            f"[ablation] {variant}: quality={result.get('quality')} "
            f"compactions={result.get('compactionStarts')} error={result.get('error')}",
            flush=True,
        )
        results.append(result)
    write_summary(args.output, results)
    return 1 if any(result.get("error") for result in results) else 0


if __name__ == "__main__":
    sys.exit(main())
