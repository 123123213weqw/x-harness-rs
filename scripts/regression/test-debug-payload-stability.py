#!/usr/bin/env python3
"""Bounded Linux Host soak using only isolated, credential-free loopback fixtures.

Reuse mode bounds the session count but retains normal conversation history.
Delete mode checks repeated creation/deletion for resource retention. Control
tombstones and full traces intentionally remain on disk.
RSS drift is an alarm threshold, not a proof of leak freedom or a heap profile.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import statistics
import subprocess
import threading
import time
import urllib.request


def rpc(port, method, payload):
    body = {
        "type": "client-request",
        "rpcId": secrets.token_hex(12),
        "method": method,
        "payload": payload,
    }
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/{method}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=30) as response:
        result = json.load(response)["result"]
    if not result["ok"]:
        raise RuntimeError(f"{method}: {result}")
    return result.get("value")


def resources(pid):
    status = dict(
        line.split(":", 1)
        for line in Path(f"/proc/{pid}/status").read_text().splitlines()
        if ":" in line
    )
    return {
        "rss_kib": int(status["VmRSS"].split()[0]),
        "peak_rss_kib": int(status["VmHWM"].split()[0]),
        "threads": int(status["Threads"]),
        "fds": len(list(Path(f"/proc/{pid}/fd").iterdir())),
    }


def trace_integrity(root):
    records = blobs = 0
    for events in root.glob("*/events.jsonl"):
        with events.open() as stream:
            for index, line in enumerate(stream):
                record = json.loads(line)
                if record["seq"] != index:
                    raise AssertionError("Trace sequence gap")
                records += 1
                reference = (
                    record["payload"].get("$debugBlob")
                    if isinstance(record["payload"], dict)
                    else None
                )
                if reference:
                    raw = (events.parent / reference["relativePath"]).read_bytes()
                    if (
                        len(raw) != reference["bytes"]
                        or hashlib.sha256(raw).hexdigest() != reference["sha256"]
                    ):
                        raise AssertionError("Trace blob mismatch")
                    json.loads(raw)
                    blobs += 1
    return {"records": records, "blob_references": blobs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--trace", choices=["off", "full"], required=True)
    parser.add_argument("--lifecycle", choices=["reuse", "delete"], required=True)
    parser.add_argument("--waves", type=int, default=24)
    parser.add_argument("--concurrency", type=int, default=8)
    args = parser.parse_args()
    if not 12 <= args.waves <= 40 or not 1 <= args.concurrency <= 16:
        parser.error("waves must be 12..40; concurrency must be 1..16")
    if not Path("/proc/self/status").is_file():
        parser.error(
            "This probe requires Linux /proc; run it on the remote test server"
        )
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    workspace = root / "workspace"
    workspace.mkdir()
    spec = importlib.util.spec_from_file_location(
        "payload_fixture", Path(__file__).with_name("benchmark-debug-payloads.py")
    )
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    fixture.CASES["soak"] = (32 * 1024, 32)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), fixture.Fixture)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    config = {
        "default": {"provider": "fixture", "model": "soak"},
        "providers": [
            {
                "id": "fixture",
                "display_name": "Soak fixture",
                "kind": "openai-compatible",
                "protocol": "chat",
                "base_url": f"http://127.0.0.1:{server.server_port}/v1",
                "api_key_env": "XHARNESS_FIXTURE_KEY",
                "models": [
                    {
                        "id": "soak",
                        "fallback_context_window_tokens": 16 * 1024 * 1024,
                        "max_output_tokens": 65536,
                        "minimum_output_tokens": 1024,
                        "token_safety_margin": 1024,
                    }
                ],
            }
        ],
    }
    (root / "providers.json").write_text(json.dumps(config))
    (root / "diagnostics-control").write_text("0")
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("XHARNESS_")
    }
    env.update(
        XHARNESS_FIXTURE_KEY="public-noncredential-fixture",
        XHARNESS_DIAGNOSTICS_DIR=str(root / "diagnostics"),
        XHARNESS_DIAGNOSTICS_CONTROL=str(root / "diagnostics-control"),
    )
    port = fixture.free_port()
    command = [
        str(args.binary.resolve()),
        "--bind",
        f"127.0.0.1:{port}",
        "--workspace",
        str(workspace),
        "--state-dir",
        str(root / "state"),
        "--providers-file",
        str(root / "providers.json"),
        "--debug-trace",
        args.trace,
        "--debug-dir",
        str(root / "trace"),
    ]
    rows = []
    result = {
        "passed": False,
        "mode": args.trace,
        "lifecycle": args.lifecycle,
        "waves": args.waves,
        "concurrency": args.concurrency,
        "binary_sha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
        "samples": rows,
        "limits": {
            "idle_rss_drift_kib": 64 * 1024,
            "host_peak_rss_kib": 1024 * 1024,
            "idle_fd_drift": 8,
        },
        "scope": "Same Host process; 32 KiB prompts, exact current-turn output/reasoning/usage checks, sample idle RSS. Reuse mode keeps a fixed session set and growing normal history; delete mode archives/deletes fresh completed sessions per wave. No real model, TLS, UI, heap profiler or multi-hour guarantee. Control receipts and full traces persist by design.",
    }
    process = None

    def interrupted(*_):
        raise KeyboardInterrupt("Soak interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    with (root / "host.log").open("w") as log:
        try:
            process = subprocess.Popen(
                command,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=env,
                start_new_session=True,
            )
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    raise RuntimeError("Host exited during startup")
                try:
                    rpc(port, "settings.describe", {})
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise TimeoutError("Host startup timed out")
                    time.sleep(0.05)
            started = time.monotonic()
            prompt = ("Inert fixture input; no external actions.\n" * 1024)[: 32 * 1024]
            fixed_ids = []
            if args.lifecycle == "reuse":
                fixed_ids = [
                    rpc(
                        port,
                        "session.create",
                        {"sessionId": f"soak-reuse-{index}", "cwd": str(workspace)},
                    )["sessionId"]
                    for index in range(args.concurrency)
                ]
            with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
                for wave in range(args.waves):
                    ids = fixed_ids or [
                        rpc(
                            port,
                            "session.create",
                            {
                                "sessionId": f"soak-{wave}-{index}",
                                "cwd": str(workspace),
                            },
                        )["sessionId"]
                        for index in range(args.concurrency)
                    ]
                    turn = wave if args.lifecycle == "reuse" else 0
                    futures = [
                        pool.submit(
                            rpc,
                            port,
                            "session.prompt",
                            {
                                "sessionId": sid,
                                "mode": "queue",
                                "content": [{"type": "text", "text": prompt}],
                            },
                        )
                        for sid in ids
                    ]
                    for future in futures:
                        future.result()
                    deadline = time.monotonic() + 60
                    while True:
                        running = {
                            item.get("sessionId", item.get("id"))
                            for item in rpc(port, "session.list", {})["items"]
                            if item.get("running")
                        }
                        if not running.intersection(ids):
                            histories = [
                                rpc(
                                    port,
                                    "session.history",
                                    {"sessionId": sid, "maxMessages": 2000},
                                )
                                for sid in ids
                            ]
                            if all(
                                any(
                                    event.get("event", event)["type"] == "turn/end"
                                    and event.get("event", event)["data"].get("turn")
                                    == turn
                                    for event in history["events"]
                                )
                                for history in histories
                            ):
                                break
                        if (
                            resources(process.pid)["rss_kib"]
                            > result["limits"]["host_peak_rss_kib"]
                        ):
                            raise AssertionError(
                                "Host RSS exceeds 1 GiB isolation limit"
                            )
                        if time.monotonic() > deadline:
                            raise TimeoutError(
                                "Wave did not complete within 60 seconds"
                            )
                        time.sleep(0.05)
                    for sid, history in zip(ids, histories):
                        events = [
                            event.get("event", event)
                            for event in history["events"]
                            if event.get("event", event)["data"].get("turn") == turn
                        ]
                        ends = [
                            event for event in events if event["type"] == "turn/end"
                        ]
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
                        usage = [
                            event["data"]["usage"]
                            for event in events
                            if event["type"] == "assistant/message"
                        ][-1]
                        if len(ends) != 1 or ends[0]["data"]["reason"] != {
                            "kind": "completed"
                        }:
                            raise AssertionError("Duplicate or failed terminal result")
                        if (
                            text != fixture.TEXT * 32 + fixture.MARKER
                            or reasoning != fixture.REASONING * 32
                        ):
                            raise AssertionError("Output or reasoning mismatch")
                        if usage != {
                            "inputTokens": 192,
                            "cacheReadTokens": 64,
                            "cacheWriteTokens": 0,
                            "outputTokens": 900,
                            "reasoningTokens": 100,
                        }:
                            raise AssertionError("Usage mismatch")
                        if args.lifecycle == "delete":
                            rpc(port, "workspace.archiveSession", {"sessionId": sid})
                            rpc(port, "session.delete", {"sessionId": sid})
                    listed = rpc(port, "session.list", {})["items"]
                    if args.lifecycle == "delete" and any(
                        item.get("sessionId", item.get("id")) in ids for item in listed
                    ):
                        raise AssertionError("Deleted session remains visible")
                    time.sleep(0.25)
                    sample = {
                        "wave": wave,
                        "verified_turns": len(ids),
                        "elapsed_seconds": time.monotonic() - started,
                        **resources(process.pid),
                    }
                    if sample["peak_rss_kib"] > result["limits"]["host_peak_rss_kib"]:
                        raise AssertionError(
                            "Host peak RSS exceeds 1 GiB isolation limit"
                        )
                    targets = {}
                    for fd in Path(f"/proc/{process.pid}/fd").iterdir():
                        try:
                            targets[fd.name] = os.readlink(fd)
                        except OSError:
                            pass
                    (root / "fd-targets-last.json").write_text(
                        json.dumps(targets, indent=2)
                    )
                    rows.append(sample)
                    (root / "results.json").write_text(json.dumps(result, indent=2))
                    print(json.dumps(sample), flush=True)
            result["verified_turns"] = sum(row["verified_turns"] for row in rows)
            early = statistics.median(row["rss_kib"] for row in rows[4:8])
            late = statistics.median(row["rss_kib"] for row in rows[-4:])
            result.update(
                early_idle_rss_kib=early,
                late_idle_rss_kib=late,
                idle_rss_drift_kib=late - early,
                fd_drift=statistics.median(row["fds"] for row in rows[-4:])
                - statistics.median(row["fds"] for row in rows[4:8]),
            )
            if result["fd_drift"] > result["limits"]["idle_fd_drift"]:
                raise AssertionError(
                    "Idle file-descriptor drift exceeds predeclared limit of 8"
                )
            if late - early > result["limits"]["idle_rss_drift_kib"]:
                raise AssertionError(
                    "Idle RSS drift exceeds predeclared 64 MiB alarm threshold"
                )
            result["passed"] = True
        except BaseException as error:
            result["error"] = str(error)
            raise
        finally:
            result["verified_turns"] = sum(row["verified_turns"] for row in rows)
            if process is not None and process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            server.shutdown()
            server.server_close()
            try:
                result["trace_integrity"] = trace_integrity(root / "trace")
                if args.trace == "full" and not result["trace_integrity"]["records"]:
                    raise AssertionError("Full trace is empty")
            except Exception as error:
                result.update(passed=False, trace_error=str(error))
            (root / "results.json").write_text(json.dumps(result, indent=2))
            print(
                json.dumps(
                    {key: value for key, value in result.items() if key != "samples"}
                ),
                flush=True,
            )
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
