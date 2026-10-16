#!/usr/bin/env python3
"""Compare two optimized Hosts against identical, credential-free SSE fixtures.

Run on Linux after building both binaries remotely. This isolates runtime work,
not LLM quality, internet latency, browser rendering, or GPU inference time.
"""

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import statistics
import subprocess
import threading
import time
import urllib.request

CASES = {
    "small": (1024, 16),
    "large_context": (2 * 1024 * 1024, 16),
    "streaming": (1024, 4096),
}
TEXT = "fixture text " * 4
REASONING = "fixture reasoning "
MARKER = "PAYLOAD_BENCH_OK"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def rpc(port, method, payload):
    body = {
        "type": "client-request",
        "rpcId": "benchmark",
        "method": method,
        "payload": payload,
    }
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/{method}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(request, timeout=30) as response:
        result = json.load(response)["result"]
    if not result["ok"]:
        raise RuntimeError(f"{method}: {result}")
    return result.get("value")


def metrics(pid):
    stat = Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].split()
    status = dict(
        line.split(":", 1)
        for line in Path(f"/proc/{pid}/status").read_text().splitlines()
        if ":" in line
    )
    return {
        "cpu_ms": (int(stat[11]) + int(stat[12])) * 1000 / os.sysconf("SC_CLK_TCK"),
        "peak_rss_kib": int(status["VmHWM"].split()[0]),
    }


class Fixture(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.endswith("/input_tokens"):
            # Exercise the production unsupported-counter cache, not a fake exact count.
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        chunks = CASES[request["model"]][1]
        frames = []
        for _ in range(chunks):
            frames.append(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": TEXT, "reasoning_content": REASONING},
                            "finish_reason": None,
                        }
                    ]
                }
            )
        frames.append(
            {
                "choices": [
                    {"index": 0, "delta": {"content": MARKER}, "finish_reason": "stop"}
                ],
                "usage": {
                    "prompt_tokens": 256,
                    "completion_tokens": 1000,
                    "prompt_tokens_details": {"cached_tokens": 64},
                    "completion_tokens_details": {"reasoning_tokens": 100},
                },
            }
        )
        body = (
            b"".join(
                b"data: " + json.dumps(frame).encode() + b"\n\n" for frame in frames
            )
            + b"data: [DONE]\n\n"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # Completion or isolated Host teardown can close the HTTP body.
            # Exact output and terminal-state gates below still detect losses.
            self.close_connection = True


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def trial(binary, arm, case, repeat, root, fixture_port):
    directory = root / f"{case}-{repeat}-{arm}"
    directory.mkdir()
    workspace = directory / "workspace"
    workspace.mkdir()
    state = directory / "state"
    config = {
        "default": {"provider": "fixture", "model": case},
        "providers": [
            {
                "id": "fixture",
                "display_name": "Isolated fixture",
                "kind": "openai-compatible",
                "protocol": "chat",
                "base_url": f"http://127.0.0.1:{fixture_port}/v1",
                "api_key_env": "XHARNESS_FIXTURE_KEY",
                "models": [
                    {
                        "id": case,
                        "fallback_context_window_tokens": 16 * 1024 * 1024,
                        "max_output_tokens": 65536,
                        "minimum_output_tokens": 1024,
                        "token_safety_margin": 1024,
                    }
                ],
            }
        ],
    }
    (directory / "providers.json").write_text(json.dumps(config))
    port = free_port()
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("XHARNESS_")
    }
    env["XHARNESS_FIXTURE_KEY"] = "public-noncredential-fixture"
    env["XHARNESS_DIAGNOSTICS_DIR"] = str(directory / "diagnostics")
    env["XHARNESS_DIAGNOSTICS_CONTROL"] = str(directory / "diagnostics-control")
    (directory / "diagnostics-control").write_text("0")
    command = [
        str(binary),
        "--bind",
        f"127.0.0.1:{port}",
        "--workspace",
        str(workspace),
        "--state-dir",
        str(state),
        "--providers-file",
        str(directory / "providers.json"),
        "--debug-trace",
        "off",
    ]
    with (directory / "host.log").open("w") as log:
        process = subprocess.Popen(
            command,
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    raise RuntimeError("Host exited during startup")
                try:
                    rpc(port, "settings.describe", {})
                    break
                except (OSError, ValueError):
                    if time.monotonic() > deadline:
                        raise TimeoutError("Host readiness timed out")
                    time.sleep(0.02)
            sid = rpc(
                port, "session.create", {"sessionId": "fixture", "cwd": str(workspace)}
            )["sessionId"]
            size, chunks = CASES[case]
            line = "Inert benchmark input; no external actions are requested.\n"
            prompt = (line * ((size // len(line)) + 1))[:size]
            before = metrics(process.pid)
            submitted = time.time() * 1000
            rpc(
                port,
                "session.prompt",
                {
                    "sessionId": sid,
                    "mode": "queue",
                    "content": [{"type": "text", "text": prompt}],
                },
            )
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                items = rpc(port, "session.list", {})["items"]
                if not any(
                    item.get("running")
                    for item in items
                    if item.get("sessionId", item.get("id")) == sid
                ):
                    after = metrics(process.pid)
                    history = rpc(
                        port,
                        "session.history",
                        {"sessionId": sid, "maxMessages": 20000},
                    )
                    events = [raw.get("event", raw) for raw in history["events"]]
                    if any(event["type"] == "turn/end" for event in events):
                        break
                time.sleep(0.05)
            else:
                raise TimeoutError("Fixture turn timed out")
            messages = [
                event["data"]["message"]
                for event in events
                if event["type"] == "assistant/message"
            ]
            text = "".join(
                block.get("text", "")
                for message in messages
                for block in message["content"]
                if block["type"] == "text"
            )
            reasoning = "".join(
                block.get("text", "")
                for message in messages
                for block in message["content"]
                if block["type"] == "reasoning"
            )
            terminal = [event for event in events if event["type"] == "turn/end"][-1]
            usage = [
                event["data"]["usage"]
                for event in events
                if event["type"] == "assistant/message"
            ][-1]
            checks = {
                "text_exact": text == TEXT * chunks + MARKER,
                "reasoning_exact": reasoning == REASONING * chunks,
                "completed": terminal["data"]["reason"] == {"kind": "completed"},
                "usage_exact": usage
                == {
                    "inputTokens": 192,
                    "cacheReadTokens": 64,
                    "cacheWriteTokens": 0,
                    "outputTokens": 900,
                    "reasoningTokens": 100,
                },
                "one_step": sum(event["type"] == "step/start" for event in events) == 1,
            }
            row = {
                "arm": arm,
                "case": case,
                "repeat": repeat,
                "task_ms": terminal["time"] - submitted,
                "host_cpu_ms": after["cpu_ms"] - before["cpu_ms"],
                "peak_host_rss_kib": after["peak_rss_kib"],
                "checks": checks,
                "usage": usage,
                "passed": all(checks.values()),
            }
            (directory / "metrics.json").write_text(json.dumps(row, indent=2))
            # Retain fixture evidence, never production history or provider credentials.
            (directory / "history.json").write_text(json.dumps(history))
            return row
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    if args.repeats < 1 or args.repeats > 30:
        parser.error("--repeats must be between 1 and 30")
    binaries = {
        "baseline": args.baseline.resolve(),
        "candidate": args.candidate.resolve(),
    }
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    manifest = {
        "binaries": {
            arm: {
                "path": str(path),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for arm, path in binaries.items()
        },
        "cases": CASES,
        "repeats": args.repeats,
        "load_average": os.getloadavg(),
        "scope": "Host-only CPU and high-water RSS; authoritative turn/end timing excludes observation polling tail. Fresh process and state, warm OS cache. Loopback scripted provider, no TLS, no real model, tracing off; payload-free runtime observer remains on. CPU resolution is the Linux process clock tick. Synthetic context capacity is not a real model limit.",
    }
    rows = []
    try:
        for case in CASES:
            for repeat in range(args.repeats):
                order = (
                    ["baseline", "candidate"]
                    if repeat % 2 == 0
                    else ["candidate", "baseline"]
                )
                for arm in order:
                    row = trial(
                        binaries[arm],
                        arm,
                        case,
                        repeat,
                        args.output,
                        server.server_port,
                    )
                    rows.append(row)
                    (args.output / "results.json").write_text(
                        json.dumps({"manifest": manifest, "results": rows}, indent=2)
                    )
                    print(json.dumps(row), flush=True)
                    if not row["passed"]:
                        raise RuntimeError("Fixture correctness gate failed")
        summary = {
            case: {
                arm: {
                    metric: statistics.median(
                        row[metric]
                        for row in rows
                        if row["case"] == case and row["arm"] == arm
                    )
                    for metric in ["task_ms", "host_cpu_ms", "peak_host_rss_kib"]
                }
                for arm in binaries
            }
            for case in CASES
        }
        (args.output / "summary.json").write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary, indent=2))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
