#!/usr/bin/env python3
"""Opt-in real-model A/B for historical checkpoint task-scope semantics.

Only synthetic fixtures are sent to the provider. Generated shell calls are
recorded but never executed; deterministic synthetic results are returned.
The credential is read from an environment variable or the macOS keychain and
never written to the report, subprocess arguments, or stdout.
"""

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.error
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent.parent
SUMMARY_SOURCE = pathlib.Path("crates/xharness-compaction/src/summary.rs")
DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions"
LEGACY_REF = "388e8df"  # main before the checkpoint-semantics change
SYSTEM = (
    "You are a coding agent. Inspect the workspace, make precise changes, and verify your work. "
    "Once the evidence is sufficient, answer directly. Preserve user work."
)
HISTORY = [
    {"role": "user", "content": "请继续验收之前的文档质量评估实验，检查结果，必要时更新报告并提交。"},
    {"role": "assistant", "content": "结果目录已有部分输出；统计表还未核对。下一步准备检查结果文件、跑测试并整理报告。"},
    {"role": "user", "content": "先确认现有结果是否完整，剩余工作等核对后再决定。"},
    {"role": "assistant", "content": "目前只检查过部分结果。报告和提交尚未完成；实验输出目录为 experiments/quality_eval/results。"},
]
TOOLS = [{
    "type": "function",
    "function": {
        "name": "bash",
        "description": (
            "Run one fresh Bash command under the active session permission policy. "
            "Pipeline failures propagate because pipefail is enabled. "
            "No shell state persists between calls."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "description": {"type": "string"},
            },
            "required": ["command"],
            "additionalProperties": False,
        },
    },
}]


def source_constant(source: str, name: str, raw: bool) -> str:
    if raw:
        pattern = rf"pub const {name}: &str = r#\"(.*?)\"#;"
    else:
        pattern = rf'pub const {name}: &str = "(.*?)";'
    match = re.search(pattern, source, re.DOTALL)
    if not match:
        raise RuntimeError(f"missing {name} in source")
    return match.group(1)


def credential(state_dir: pathlib.Path) -> str:
    if value := os.environ.get("XHARNESS_EVAL_API_KEY"):
        return value
    service = "com.xlang.xharness.models." + hashlib.sha256(
        str(state_dir.resolve()).encode()
    ).hexdigest()
    result = subprocess.run(
        ["security", "find-generic-password", "-s", service,
         "-a", "XHARNESS_DEEPSEEK_ONLY_KEY", "-w"],
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


class Client:
    def __init__(self, key: str, endpoint: str, model: str):
        self.key, self.endpoint, self.model = key, endpoint, model

    def complete(self, messages, *, tools=None, effort="low", max_tokens=1024):
        body = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "temperature": 0,
            "max_tokens": max_tokens,
            "thinking": {"type": "enabled"},
            "reasoning_effort": effort,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(body, ensure_ascii=False).encode(),
            headers={
                "Authorization": "Bearer " + self.key,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        for attempt in range(3):
            started = time.monotonic()
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    payload = json.load(response)
                return payload, round(time.monotonic() - started, 3)
            except urllib.error.HTTPError as error:
                # Read no body: gateway error pages might contain request data.
                if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                    raise RuntimeError(f"provider HTTP {error.code}") from None
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise RuntimeError("provider transport failure") from None
            time.sleep(1 + attempt)
        raise AssertionError("unreachable")


def compact(client, instruction):
    messages = [{"role": "system", "content": SYSTEM}, *HISTORY,
                {"role": "user", "content": instruction}]
    for max_tokens in (1536, 3072, 6144):
        payload, elapsed = client.complete(
            messages, effort="low", max_tokens=max_tokens,
        )
        choice = payload["choices"][0]
        if choice["finish_reason"] == "stop" and choice["message"].get("content"):
            return choice["message"]["content"], payload.get("usage", {}), elapsed
    raise RuntimeError("summary incomplete after bounded output growth")


def synthetic_result(command):
    lower = command.lower()
    output = []
    if "pwd" in lower or "ls " in lower or "find " in lower:
        output.append(
            "/home/wzu/workspace\nexperiments/quality_eval/results/metrics.csv\n"
            "experiments/quality_eval/results/manifest.json\n"
            "experiments/quality_eval/README.md"
        )
    if any(term in lower for term in ("experiments/", "quality_eval", "metrics.csv", "manifest.json", "report")):
        output.append(
            "manifest.json: expected_files=[metrics.csv,manifest.json]; "
            "present_files=[metrics.csv,manifest.json]; missing_files=[]; run_status=complete.\n"
            "metrics.csv: 10/10 records, no null scores, mean_quality=0.91.\n"
            "README.md: validation requires checking the manifest and record count."
        )
    if any(term in lower for term in ("uptime", "loadavg", "nproc", "top", "vmstat", "ps ", "cpuinfo")):
        output.append(
            "uptime: load average: 1.42, 1.31, 1.20; 16 CPU cores; "
            "CPU: 18% busy; top processes: model-server pid 2201 14% CPU, "
            "xharness-host pid 2210 2% CPU."
        )
    if any(term in lower for term in ("free", "meminfo", "memory.current", "--sort=-rss")):
        output.append("Mem: 19 GiB used / 64 GiB total; available 45 GiB; swap 0 GiB used.")
    if "nvidia-smi" in lower or "rocm-smi" in lower or "gpu" in lower:
        output.append(
            "GPU 0: 48% utilization, 37 GiB / 80 GiB VRAM, 61 C; "
            "compute app: model-server pid 2201 uses 36 GiB, display pid 110 uses 1 GiB."
        )
    if "df " in lower or "du " in lower:
        output.append("Filesystem /: 216 GiB used / 512 GiB total (42%).")
    if "git " in lower:
        output.append("git status: clean; branch main. No repository changes were made.")
    return "\n".join(output) if output else "Command exited 0. No additional output."


def run_trial(client, preamble, summary, question, arm, repetition):
    messages = [{"role": "system", "content": SYSTEM}]
    if summary is not None:
        messages.append({"role": "user", "content": preamble + "\n\n<compacted-summary>\n" + summary + "\n</compacted-summary>"})
    messages.append({"role": "user", "content": question})
    commands, tool_count, usage, seconds, final = [], 0, 0, 0.0, ""
    for _ in range(5):
        payload, elapsed = client.complete(messages, tools=TOOLS, effort="max", max_tokens=2048)
        seconds += elapsed
        usage += payload.get("usage", {}).get("total_tokens", 0)
        choice = payload["choices"][0]
        message = choice["message"]
        calls = message.get("tool_calls") or []
        if not calls:
            final = message.get("content") or ""
            break
        # Keep provider-specific reasoning fields only in memory for valid
        # continuation. The report stores neither reasoning nor credentials.
        messages.append(message)
        for call in calls:
            tool_count += 1
            try:
                args = json.loads(call["function"]["arguments"])
                command = args.get("command", "")
            except (ValueError, KeyError):
                command = ""
            commands.append(command)
            messages.append({
                "role": "tool", "tool_call_id": call["id"],
                "content": synthetic_result(command),
            })
    # Reading the old experiment's data files is a clear scope expansion for
    # resource-only questions. Process-name inspection alone may still help
    # attribute CPU/GPU usage, so it is not counted here.
    old_artifact_commands = [
        c for c in commands if any(
            term in c.lower() for term in
            ("experiments/quality_eval/", "metrics.csv", "manifest.json")
        )
    ]
    is_resume = question.startswith("继续刚才的文档质量实验")
    return {
        "arm": arm, "repeat": repetition, "question": question,
        "tool_count": tool_count,
        "old_artifact_tool_count": len(old_artifact_commands),
        "offscope_artifact_tool_count": 0 if is_resume else len(old_artifact_commands),
        "commands": commands, "final": final,
        "reported_old_project": any(t in final.lower() for t in ("实验", "报告", "质量评估", "quality_eval")),
        "usage_tokens": usage, "latency_seconds": round(seconds, 3),
        "completed": bool(final),
    }


def recognition_probe(client, preamble, summary, arm, repetition):
    question = (
        "继续刚才的文档质量实验，先检查现有结果是否完整。"
        "请只用一句话说明你下一步要核对什么，不调用工具。"
    )
    payload, elapsed = client.complete([
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": preamble + "\n\n<compacted-summary>\n" + summary + "\n</compacted-summary>"},
        {"role": "user", "content": question},
    ], effort="max", max_tokens=1024)
    answer = payload["choices"][0]["message"].get("content") or ""
    return {
        "arm": arm, "repeat": repetition, "answer": answer,
        "recognized_result_check": (
            any(word in answer for word in ("结果", "输出文件", "统计表"))
            and any(word in answer for word in
                    ("完整", "齐全", "缺失", "预期生成清单", "manifest", "对应"))
        ),
        "usage_tokens": payload.get("usage", {}).get("total_tokens", 0),
        "latency_seconds": elapsed,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--model", default="deepseek-flash")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--baseline-ref", default=LEGACY_REF)
    parser.add_argument(
        "--state-dir", default=str(pathlib.Path.home() /
                                   "Library/Application Support/com.xlang.xharness/state"),
    )
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error("repeats must be in 1..10")
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    latest = (ROOT / SUMMARY_SOURCE).read_text()
    original = subprocess.run(
        ["git", "show", f"{args.baseline_ref}:{SUMMARY_SOURCE.as_posix()}"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    client = Client(credential(pathlib.Path(args.state_dir)), args.endpoint, args.model)
    arms = {}
    for label, source in (("legacy", original), ("revised", latest)):
        instruction = source_constant(source, "DEFAULT_COMPACTION_INSTRUCTION", True)
        summary, usage, elapsed = compact(client, instruction)
        arms[label] = {
            "summary": summary,
            "preamble": source_constant(source, "CHECKPOINT_PREAMBLE", False),
            "summary_usage_tokens": usage.get("total_tokens", 0),
            "summary_latency_seconds": elapsed,
        }
        print(f"{label} summary ready, tokens={usage.get('total_tokens', 0)}", flush=True)
    questions = [
        "现在机器负载呢？",
        "先别继续之前的实验，只看当前 CPU、内存和 GPU 占用。",
        "继续刚才的文档质量实验，先检查现有结果是否完整。",
    ]
    trials = []
    for question in questions:
        for repetition in range(args.repeats):
            for label in (("legacy", "revised") if repetition % 2 == 0 else ("revised", "legacy")):
                arm = arms[label]
                result = run_trial(client, arm["preamble"], arm["summary"], question, label, repetition + 1)
                trials.append(result)
                print(f"{label} #{repetition + 1}: calls={result['tool_count']} offscope_artifacts={result['offscope_artifact_tool_count']} tokens={result['usage_tokens']}", flush=True)
    recognition = [
        recognition_probe(client, arms[label]["preamble"], arms[label]["summary"], label, repetition + 1)
        for label in ("legacy", "revised")
        for repetition in range(args.repeats)
    ]
    baseline = [
        run_trial(client, "", None, questions[0], "fresh_no_checkpoint", repetition + 1)
        for repetition in range(args.repeats)
    ]
    output.write_text(json.dumps({
        "model": args.model,
        "baseline_ref": args.baseline_ref,
        "fixture": HISTORY,
        "arms": {label: {k: v for k, v in arm.items() if k != "preamble"} for label, arm in arms.items()},
        "trials": trials,
        "fresh_baseline": baseline,
        "continuation_recognition": recognition,
        "note": "Synthetic tool results only; no generated command was executed. No private reasoning or credential is stored.",
    }, ensure_ascii=False, indent=2))
    print("report", output, flush=True)


if __name__ == "__main__":
    main()
