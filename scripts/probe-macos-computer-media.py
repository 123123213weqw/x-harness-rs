#!/usr/bin/env python3
"""Opt-in native screenshot/attachment regression. Uses a local SSE fixture, not an LLM.

Run with a remotely built macOS Host binary. Creates disposable state and takes
only a 64x64-point screen crop; retains hashes/counts, never AX text/image bytes.
Does not change TCC or restart/replace an installed application.
"""

import argparse
import base64
import hashlib
import json
import os
import signal
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def objects(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def png_info(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not PNG"
    width, height = struct.unpack(">II", data[16:24])
    return {
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "width": width,
        "height": height,
    }


class Fixture:
    def __init__(self):
        self.case = ""
        self.args = {}
        self.records = []
        self.counts = {}

    def handler(self):
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                data = json.dumps(
                    {
                        "object": "list",
                        "data": [{"id": "native-capture", "object": "model"}],
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                payload = json.loads(
                    self.rfile.read(int(self.headers["Content-Length"]))
                )
                if self.path.endswith("/input_tokens"):
                    data = json.dumps({"input_tokens": 256}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                if not payload.get("tools"):
                    data = json.dumps(
                        {
                            "choices": [
                                {
                                    "message": {
                                        "role": "assistant",
                                        "content": "Native capture probe",
                                    },
                                    "finish_reason": "stop",
                                }
                            ]
                        }
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                case = fixture.case
                index = fixture.counts.get(case, 0) + 1
                fixture.counts[case] = index
                images = [
                    png_info(base64.b64decode(s.split(",", 1)[1]))
                    for s in strings(payload)
                    if s.startswith("data:image/png;base64,")
                ]
                summaries = []
                for text in strings(payload.get("messages", [])):
                    try:
                        value = json.loads(text)
                    except (ValueError, TypeError):
                        continue
                    if (
                        isinstance(value, dict)
                        and value.get("action") == "observe"
                        and "screenshot_included" in value
                    ):
                        ax = value.get("accessibility", {})
                        summaries.append(
                            {
                                "screenshot_included": value["screenshot_included"],
                                "permissions": value.get("permissions", {}),
                                "accessibility": {
                                    "status": ax.get("status"),
                                    "error": {
                                        "code": (ax.get("error") or {}).get("code")
                                    },
                                    "node_count": len(ax.get("nodes", [])),
                                    "truncation_reasons": ax.get(
                                        "truncation_reasons", []
                                    ),
                                },
                            }
                        )
                fixture.records.append(
                    {
                        "summaries": summaries,
                        "case": case,
                        "request": index,
                        "images": images,
                        "computer_registered": any(
                            x.get("name") == "computer"
                            for x in objects(payload.get("tools", []))
                        ),
                    }
                )
                if index == 1:
                    delta = {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "capture-" + case,
                                "type": "function",
                                "function": {
                                    "name": "computer",
                                    "arguments": json.dumps(fixture.args),
                                },
                            }
                        ],
                    }
                    finish = "tool_calls"
                else:
                    delta = {"role": "assistant", "content": "capture fixture complete"}
                    finish = "stop"
                chunks = [
                    {
                        "id": "capture-fixture",
                        "object": "chat.completion.chunk",
                        "model": "native-capture",
                        "choices": [
                            {"index": 0, "delta": delta, "finish_reason": None}
                        ],
                    },
                    {
                        "id": "capture-fixture",
                        "object": "chat.completion.chunk",
                        "model": "native-capture",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                        "usage": {
                            "prompt_tokens": 256,
                            "completion_tokens": 32,
                            "total_tokens": 288,
                        },
                    },
                ]
                data = (
                    "".join("data: " + json.dumps(c) + "\n\n" for c in chunks)
                    + "data: [DONE]\n\n"
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        return Handler


class RPC:
    def __init__(self, port):
        self.origin = "http://127.0.0.1:" + str(port)
        self.seq = 0

    def call(self, method, payload):
        self.seq += 1
        body = json.dumps(
            {
                "type": "client-request",
                "rpcId": "capture-" + str(self.seq),
                "method": method,
                "payload": payload,
            }
        ).encode()
        request = urllib.request.Request(
            self.origin + "/api/" + method,
            data=body,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            envelope = json.load(response)
        result = envelope.get("result", {})
        if result.get("ok") is not True:
            raise RuntimeError("RPC failed: " + method + " " + json.dumps(result))
        return result.get("value")


def events(history):
    return [entry.get("event", entry) for entry in history["events"]]


def wait_turn(rpc, sid, expected_ends, timeout=70):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        history = rpc.call("session.history", {"sessionId": sid})
        ends = [e for e in events(history) if e.get("type") == "turn/end"]
        if len(ends) >= expected_ends:
            assert ends[-1]["data"]["reason"]["kind"] != "error", "capture turn failed"
            return history
        time.sleep(0.2)
    raise RuntimeError("turn did not settle")


def settled_histories(rpc, sessions):
    # Title generation is asynchronous and can append events after turn/end.
    # Compare the final pre-shutdown journal, not an earlier live UI snapshot.
    previous = None
    stable_since = time.monotonic()
    deadline = stable_since + 10
    while time.monotonic() < deadline:
        current = {
            sid: rpc.call("session.history", {"sessionId": sid})["events"]
            for sid in sessions
        }
        if current != previous:
            previous = current
            stable_since = time.monotonic()
        elif time.monotonic() - stable_since >= 1:
            return current
        time.sleep(0.2)
    raise RuntimeError("background history updates did not settle")


def stop(process):
    if process and process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host-binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--screenshot-only", action="store_true")
    args = parser.parse_args()
    if os.uname().sysname != "Darwin":
        parser.error("native macOS required")
    fixture = Fixture()
    server = ThreadingHTTPServer(("127.0.0.1", 0), fixture.handler())
    threading.Thread(target=server.serve_forever, daemon=True).start()
    report = {
        "scope": "real native Host/ComputerTool/attachment/provider-wire/history, deterministic local SSE provider (no external model)",
        "host_sha256": hashlib.sha256(args.host_binary.read_bytes()).hexdigest(),
        "cases": [],
        "passed": False,
    }
    process = None
    with tempfile.TemporaryDirectory(prefix="xh-native-media-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        config = {
            "default": {"provider": "native-capture-probe", "model": "native-capture"},
            "providers": [
                {
                    "id": "native-capture-probe",
                    "base_url": "http://127.0.0.1:" + str(server.server_port) + "/v1",
                    "api_key_env": "XHARNESS_CAPTURE_FIXTURE_KEY",
                    "models": [
                        {
                            "id": "native-capture",
                            "fallback_context_window_tokens": 65536,
                            "max_output_tokens": 4096,
                            "image_input": True,
                        }
                    ],
                }
            ],
        }
        providers = root / "providers.json"
        providers.write_text(json.dumps(config))
        port = free_port()
        rpc = RPC(port)
        command = [
            str(args.host_binary.resolve()),
            "--bind",
            "127.0.0.1:" + str(port),
            "--workspace",
            str(workspace),
            "--state-dir",
            str(root / "state"),
            "--providers-file",
            str(providers),
            "--tool-allowlist",
            "computer",
            "--compaction-config",
            "off",
        ]
        env = os.environ.copy()
        for key in list(env):
            if key.startswith("XHARNESS_") or key in (
                "OPENAI_API_KEY",
                "GH_TOKEN",
                "GITHUB_TOKEN",
            ):
                env.pop(key, None)
        env["XHARNESS_CAPTURE_FIXTURE_KEY"] = "local-fixture-not-a-credential"
        env["NO_PROXY"] = "127.0.0.1,localhost"
        histories = {}
        attachments = {}

        def start_host():
            log = (root / "host.log").open("ab")
            proc = subprocess.Popen(
                command, env=env, stdout=log, stderr=subprocess.STDOUT
            )
            log.close()
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise RuntimeError("candidate host exited before readiness")
                try:
                    rpc.call("workspace.list", {})
                    return proc
                except Exception:
                    time.sleep(0.1)
            stop(proc)
            raise RuntimeError("candidate host ready timeout")

        try:
            process = start_host()
            cases = [
                (
                    "screenshot_only",
                    {
                        "action": "observe",
                        "include_accessibility": False,
                        "include_screenshot": True,
                    },
                )
            ]
            if not args.screenshot_only:
                cases += [
                    (
                        "ax_auto",
                        {
                            "action": "observe",
                            "detail": "auto",
                            "include_screenshot": True,
                        },
                    ),
                    (
                        "ax_semantic",
                        {
                            "action": "observe",
                            "detail": "semantic",
                            "include_screenshot": True,
                        },
                    ),
                ]
            for name, request in cases:
                sid = "capture-" + name
                fixture.case = name
                fixture.args = {
                    **request,
                    "region": {"x": 0, "y": 0, "width": 64, "height": 64},
                }
                rpc.call(
                    "session.create",
                    {"workspaceId": "workspace-default", "sessionId": sid},
                )
                rpc.call(
                    "commands/execute",
                    {
                        "args": {
                            "agentId": sid,
                            "line": "/permission danger-full-access",
                            "images": [],
                        }
                    },
                )
                before = rpc.call("session.history", {"sessionId": sid})
                expected_ends = 1 + sum(
                    e.get("type") == "turn/end" for e in events(before)
                )
                start = time.monotonic()
                rpc.call(
                    "session.prompt",
                    {
                        "sessionId": sid,
                        "mode": "queue",
                        "content": [
                            {"type": "text", "text": "read-only native capture " + name}
                        ],
                    },
                )
                history = wait_turn(rpc, sid, expected_ends)
                elapsed = round(time.monotonic() - start, 3)
                tool = [e for e in events(history) if e.get("type") == "tool/result"]
                assert len(tool) == 1, "expected exactly one computer tool result"
                message = tool[0]["data"]["message"]
                result = next(
                    o for o in objects(message) if o.get("type") == "tool-result"
                )
                if result.get("isError"):
                    raise RuntimeError("computer failed")
                texts = [
                    o["text"]
                    for o in objects(result["content"])
                    if o.get("type") == "text"
                ]
                raw = json.loads(texts[0])
                # The ordinary history text has a valid JSON envelope but may
                # contain a head/tail excerpt, not a parseable inner summary.
                # The media blocks carry the actual observation to the provider.
                wire_summaries = [
                    value
                    for record in fixture.records
                    if record["case"] == name and record["request"] > 1
                    for value in record["summaries"]
                ]
                assert (
                    wire_summaries
                ), "full observation metadata did not reach provider"
                summary = wire_summaries[-1]
                assert (
                    summary.get("screenshot_included") is True
                ), "native screenshot missing"
                images = [
                    o["attachment"]
                    for o in objects(history)
                    if o.get("type") == "image"
                    and isinstance(o.get("attachment"), dict)
                ]
                assert images, "durable history attachment reference missing"
                attachment = images[-1]
                aid = attachment["attachmentId"]
                resolved = rpc.call(
                    "session.attachment", {"sessionId": sid, "attachmentId": aid}
                )
                info = png_info(base64.b64decode(resolved["data"]))
                assert (
                    0 < info["width"] <= 256 and 0 < info["height"] <= 256
                ), "crop did not constrain capture"
                received = [
                    i
                    for r in fixture.records
                    if r["case"] == name and r["request"] > 1
                    for i in r["images"]
                ]
                assert any(
                    i["sha256"] == info["sha256"] for i in received
                ), "provider did not receive same screenshot bytes"
                assert not any(
                    s.startswith("data:image") or s.startswith("iVBOR")
                    for s in strings(history)
                ), "inline image bytes in history"
                assert fixture.counts[name] == 2, "unexpected retry/replay"
                assert all(
                    record["computer_registered"]
                    for record in fixture.records
                    if record["case"] == name
                ), "computer schema missing from provider request"
                ax = summary.get("accessibility", {})
                permission = summary.get("permissions", {})
                if name.startswith("ax_"):
                    assert (
                        permission.get("accessibility") is True
                    ), "AX permission blocked native tree acceptance"
                row = {
                    "case": name,
                    "seconds": elapsed,
                    "image": info,
                    "accessibility_status": ax.get("status"),
                    "ax_error_code": (ax.get("error") or {}).get("code"),
                    "nodes": ax.get("node_count", 0),
                    "truncation_reasons": ax.get("truncation_reasons", []),
                    "permissions": permission,
                    "history_text_reduced": raw.get("truncated", False),
                    "passed": True,
                }
                report["cases"].append(row)
                print(json.dumps(row), flush=True)
                histories[sid] = history["events"]
                attachments[sid] = (aid, info)
            other = "capture-isolation"
            rpc.call(
                "session.create",
                {"workspaceId": "workspace-default", "sessionId": other},
            )
            sid = next(iter(attachments))
            aid, _ = attachments[sid]
            try:
                rpc.call(
                    "session.attachment", {"sessionId": other, "attachmentId": aid}
                )
            except RuntimeError:
                report["cross_session_denied"] = True
            else:
                raise RuntimeError("cross-session attachment leaked")
            histories = settled_histories(rpc, histories)
            counts = dict(fixture.counts)
            stop(process)
            process = start_host()
            for sid, expected in histories.items():
                restored = rpc.call("session.history", {"sessionId": sid})
                assert restored["events"] == expected, "restart changed history"
                aid, info = attachments[sid]
                resolved = rpc.call(
                    "session.attachment", {"sessionId": sid, "attachmentId": aid}
                )
                assert (
                    png_info(base64.b64decode(resolved["data"])) == info
                ), "restart lost image"
            assert counts == fixture.counts, "restart replayed capture"
            report.update(
                restart_history_and_image=True,
                restart_without_tool_replay=True,
                passed=True,
            )
        except Exception as error:
            report["error"] = str(error)
            print(json.dumps({"error": str(error)}), flush=True)
            # Logs can include UI text; do not retain them or snapshots.
        finally:
            stop(process)
            server.shutdown()
            server.server_close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
