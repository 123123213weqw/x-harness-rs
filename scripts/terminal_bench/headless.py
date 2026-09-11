"""Run the actual XHarness host once inside an isolated benchmark container.

stdin: instruction, broker_url, capability (NOT the provider's real API key).
Artifacts live under /logs/agent; evaluator owns hidden grading after this exits.
"""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from relay import Relay
from launcher_control import begin_trial
from official_headless import stop_process_group


class Rpc:
    def __init__(self, port):
        self.base = f"http://127.0.0.1:{port}"
        self.counter = 0

    def call(self, method, payload):
        self.counter += 1
        request = urllib.request.Request(self.base + "/api/" + method, data=json.dumps({
            "type": "client-request", "rpcId": str(self.counter), "method": method,
            "payload": payload}).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.load(response)["result"]
        if result.get("ok") is not True:
            raise RuntimeError("RPC failed: " + method)
        return result.get("value")


def events(history):
    return [entry.get("event", entry) for entry in history.get("events", [])]


def finished(history, sessions):
    ended = any(event.get("type") == "turn/end" for event in events(history))
    items = sessions.get("items", []) if isinstance(sessions, dict) else sessions
    return ended and not any(item.get("running") for item in items)


def exit_code(status):
    # Distinguish a normal evaluation deadline from a broken adapter.
    return {"settled": 0, "timeout": 124}.get(status, 1)


def main():
    config = json.load(sys.stdin)
    root = Path("/logs/agent/xharness")
    root.mkdir(parents=True, exist_ok=False)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    rpc = Rpc(port)
    relay = Relay()
    env = os.environ.copy()
    capability = config.pop("capability")
    env["XHARNESS_API_KEY"] = capability
    command = ["/opt/xharness/xharness-host", "--bind", f"127.0.0.1:{port}",
               "--workspace", str(Path.cwd()), "--state-dir", str(root / "state"),
               "--provider", "deepseek-pilot", "--model", "deepseek-flash",
               "--base-url", relay.url, "--context-window", str(config.get('context_window', 65536)),
               "--max-output-tokens", str(config.get('max_output_tokens', 4096)), "--token-safety-margin", "1024",
               "--debug-trace", "off"]
    start = time.monotonic()
    report = {"status": "starting", "protocol": "actual-host-rpc", "context_window": 65536}
    with (root / "host.log").open("w") as log:
        process = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        env.pop("XHARNESS_API_KEY")
        try:
            deadline = time.monotonic() + 25
            while True:
                if process.poll() is not None:
                    raise RuntimeError("host exited during startup")
                try:
                    settings = rpc.call("settings.describe", {})
                    break
                except (OSError, ValueError, RuntimeError):
                    if time.monotonic() >= deadline:
                        raise TimeoutError("host startup timeout")
                    time.sleep(0.25)
            permission = next(item for item in settings["namespaces"] if item["ns"] == "permission")
            rpc.call("settings.mutate", {"ns": "permission", "ops": [
                {"op": "set", "path": ["defaultPreset"], "value": "danger-full-access"}],
                "expectedRevision": permission["revision"]})
            sid = rpc.call("session.create", {"sessionId": "benchmark", "cwd": str(Path.cwd())})["sessionId"]
            begin_trial(config, relay.url, capability)
            submitted = time.monotonic()
            report['startup_seconds'] = submitted - start
            rpc.call("session.prompt", {"sessionId": sid, "mode": "queue", "content": [
                {"type": "text", "text": config["instruction"]}]})
            quiet = 0
            while time.monotonic() - submitted < config.get('seconds', 290):
                history = rpc.call("session.history", {"sessionId": sid, "maxMessages": 2000})
                quiet = quiet + 1 if finished(history, rpc.call("session.list", {})) else 0
                if quiet >= 3:
                    report["status"] = "settled"
                    report["turn_reasons"] = [event.get("data", {}).get("reason") for event in events(history) if event.get("type") == "turn/end"]
                    (root / "history.json").write_text(json.dumps(history))
                    break
                time.sleep(0.5)
            else:
                report["status"] = "timeout"
                (root / "history.json").write_text(json.dumps(history))
        except Exception as error:
            report["status"] = "adapter_error"
            report["error"] = str(error)
        finally:
            # Stop only the process group created for this isolated host.
            stop_process_group(process)
            if 'submitted' in locals():
                report['agent_seconds'] = time.monotonic() - submitted
            report["elapsed_seconds"] = time.monotonic() - start
            (root / "adapter.json").write_text(json.dumps(report, indent=2))
            relay.stop()
    print(json.dumps(report))
    return exit_code(report["status"])


if __name__ == "__main__":
    sys.exit(main())
