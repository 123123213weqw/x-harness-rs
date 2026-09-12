"""Six bounded public-task trials; credential JSON arrives on stdin only."""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from importlib.metadata import version
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
from harbor.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig, VerifierConfig
from harbor.trial.trial import Trial
import agents
from broker import Broker

TASK_REVISION = "7131e4375048a0e408a8fb404b5f499d726b695b"
TASKS = ("cancel-async-tasks", "build-cython-ext", "log-summary-date-ranges")


async def run(args):
    credential = json.load(sys.stdin)
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    socket_dir = tempfile.TemporaryDirectory(prefix="xharness-broker-")
    broker = Broker(credential.pop("api_key"), "127.0.0.1", Path(socket_dir.name) / "api.sock")
    del credential
    agents.BROKER = broker
    agents.BINARY = args.binary.resolve(strict=True)
    order = [(task, agent) for index, task in enumerate(TASKS)
             for agent in (("xharness", "terminus") if index % 2 == 0 else ("terminus", "xharness"))]
    protocol = {"harbor": "0.16.1", "source_revision": "5fbf964", "task_revision": TASK_REVISION,
                "model": "deepseek-flash", "thinking": "enabled", "reasoning_effort": "high",
                "order": order, "agent_timeout": 300, "max_calls": 40,
                "max_output_tokens": 4096, "conservative_budget_per_trial_usd": 0.30,
                "context_limit": 65536, "selected_from_metadata_before_results": True,
                "task_selection": "Python async, dependency/build repair, log/data processing; no GPU; heavy GCC-image task excluded before scoring",
                "limitations": ["3 selected tasks, 1 sample per cell", "shortened agent deadline versus official tasks", "not a leaderboard score"]}
    protocol["dependencies"] = {name: version(name) for name in ("harbor", "litellm", "openai", "pydantic", "tiktoken")}
    with agents.BINARY.open("rb") as stream:
        protocol["binary_sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    (root / "protocol.json").write_text(json.dumps(protocol, indent=2))
    reports = []
    try:
        for task, agent in order:
            name = f"{task}--{agent}"
            print(json.dumps({"event": "start", "trial": name}), flush=True)
            start = time.monotonic()
            config = TrialConfig(
                task=TaskConfig(path=args.tasks.resolve() / task), trial_name=name, trials_dir=root,
                agent=AgentConfig(import_path="agents:XHarnessAgent" if agent == "xharness" else "agents:BoundedTerminus",
                                  model_name="openai/deepseek-flash", override_timeout_sec=300,
                                  override_setup_timeout_sec=240),
                environment=EnvironmentConfig(type="docker", delete=True, cpu_enforcement_policy="limit", memory_enforcement_policy="limit",
                    mounts=[{"type": "bind", "source": socket_dir.name, "target": "/opt/benchmark-broker", "read_only": True}]),
                verifier=VerifierConfig(override_timeout_sec=300))
            try:
                trial = await Trial.create(config)
                result = await trial.run()
                row = result.model_dump(mode="json")
            except Exception as error:
                # No raw exception text here: third-party clients may embed requests.
                row = {"infrastructure_error": type(error).__name__}
            finally:
                if agents.LEDGER:
                    budget = agents.LEDGER.close()
                    agents.LEDGER = None
                else:
                    budget = {"requests": 0}
                broker.ledger = None
            row.update(pilot_trial=name, pilot_elapsed=time.monotonic() - start, pilot_budget=budget)
            reports.append(row)
            (root / "pilot-report.json").write_text(json.dumps(reports, indent=2))
            print(json.dumps({"event": "end", "trial": name, "seconds": row["pilot_elapsed"],
                              "verifier": row.get("verifier_result"), "error": row.get("exception_info", row.get("infrastructure_error")),
                              "requests": budget["requests"]}), flush=True)
            if budget["requests"] == 0 and (row.get("exception_info") or row.get("infrastructure_error")):
                # Repeating an unavailable setup cannot measure model quality.
                print(json.dumps({"event": "stopped", "reason": "pre-model infrastructure failure",
                                  "unstarted_trials": len(order) - len(reports)}), flush=True)
                break
    finally:
        broker.stop()
        socket_dir.cleanup()


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--tasks", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(run(parser.parse_args()))
