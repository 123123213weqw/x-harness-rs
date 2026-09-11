"""Harbor adapters. XHarness runs its real binary and tools inside the task.

The control process supplies BROKER; no real API key is placed in agent kwargs,
container files/environment, or Harbor's serialized trial configuration.
"""
import json
from pathlib import Path
import tempfile
from harbor.agents.base import BaseAgent
from harbor.agents.terminus_2.terminus_2 import Terminus2
from harbor.trial.errors import AgentTimeoutError
from broker import Ledger
from health import check_dependencies

BROKER = None
BINARY = None
LEDGER = None


def activate():
    global LEDGER
    if BROKER is None:
        raise RuntimeError("broker is not configured")
    LEDGER = Ledger()
    BROKER.ledger = LEDGER
    return LEDGER


def record_budget(context):
    report = LEDGER.close()
    usage = [row["usage"] for row in report["rows"] if row["usage"]]
    context.n_input_tokens = sum(row.get("prompt_tokens", 0) for row in usage)
    context.n_cache_tokens = sum(row.get("prompt_cache_hit_tokens", 0) for row in usage)
    context.n_output_tokens = sum(row.get("completion_tokens", 0) for row in usage)
    context.metadata = dict(context.metadata or {}, broker=report)
    # Peak/no-cache conservative bound is NOT a billed dollar measurement.
    context.cost_usd = None


class XHarnessAgent(BaseAgent):
    @staticmethod
    def name():
        return "xharness-pilot"

    def version(self):
        return "5fbf964"

    async def setup(self, environment):
        await check_dependencies(environment)
        if BINARY is None:
            raise RuntimeError("binary is not configured")
        result = await environment.exec("mkdir -p /opt/xharness /logs/agent", timeout_sec=15)
        if result.return_code:
            raise RuntimeError("cannot create agent directories")
        await environment.upload_file(BINARY, "/opt/xharness/xharness-host")
        await environment.upload_file(Path(__file__).with_name("headless.py"), "/opt/xharness/headless.py")
        await environment.upload_file(Path(__file__).with_name("relay.py"), "/opt/xharness/relay.py")
        result = await environment.exec("python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.connect(\"/opt/benchmark-broker/api.sock\"); s.close()'", timeout_sec=10)
        if result.return_code:
            raise RuntimeError("broker Unix socket preflight failed")
        result = await environment.exec("chmod 755 /opt/xharness/xharness-host; command -v python3; command -v bash", timeout_sec=15)
        if result.return_code:
            raise RuntimeError("required interpreter missing")

    async def run(self, instruction, environment, context):
        ledger = activate()
        try:
            with tempfile.TemporaryDirectory(prefix="xharness-pilot-input-") as temporary:
                config = Path(temporary) / "input.json"
                config.write_text(json.dumps({"instruction": instruction, "broker_url": BROKER.url,
                                             "capability": ledger.token}))
                config.chmod(0o600)
                await environment.upload_file(config, "/opt/xharness/input.json")
            result = await environment.exec(
                "python3 /opt/xharness/headless.py < /opt/xharness/input.json",
                timeout_sec=300)
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            (self.logs_dir / "launcher.json").write_text(json.dumps(result.model_dump(), indent=2))
            context.metadata = {"adapter_exit_code": result.return_code}
            if result.return_code == 124:
                # Harbor catches this specific error and still runs the verifier.
                raise AgentTimeoutError("XHarness reached the pilot deadline")
            if result.return_code:
                raise RuntimeError("XHarness headless adapter failed; inspect launcher and host logs")
        finally:
            record_budget(context)


class BoundedTerminus(Terminus2):
    async def setup(self, environment):
        await check_dependencies(environment)
        await super().setup(environment)

    def __init__(self, *args, **kwargs):
        # Real reference implementation; only endpoint/limits/model metadata differ.
        kwargs.update(api_base=BROKER.url, max_turns=40,
                      model_info={"max_input_tokens": 65536, "max_output_tokens": 4096,
                                  "input_cost_per_token": 0.0000003,
                                  "output_cost_per_token": 0.0000012,
                                  "litellm_provider": "openai", "mode": "chat"},
                      llm_kwargs={"api_key": "not-active-yet"},
                      record_terminal_session=False)
        super().__init__(*args, **kwargs)

    async def run(self, instruction, environment, context):
        ledger = activate()
        # LiteLLM accepts request credentials from constructor kwargs; never env.
        self._llm._llm_kwargs["api_key"] = ledger.token
        try:
            return await super().run(instruction, environment, context)
        finally:
            self._llm._llm_kwargs.pop("api_key", None)
            record_budget(context)
