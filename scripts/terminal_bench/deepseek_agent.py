"""Native full-headless adapters, without a replacement reasoning loop."""
import asyncio
import json
from pathlib import Path
import tempfile
import time
from harbor.agents.base import BaseAgent
from harbor.trial.errors import AgentTimeoutError
from broker import Ledger
from protocol import OFFICIAL

BROKER = None
PROTOCOL = OFFICIAL
LEDGER = None


class NativeAgent(BaseAgent):
    harness = 'official'

    @staticmethod
    def name():
        return 'official-deepseek-full-headless'

    def version(self):
        return '0.1.5-rc.1' if self.harness == 'official' else '5fbf964067149ff448ba25b2343a3dae733fe028'

    async def setup(self, environment):
        command = ('command -v python3 && command -v bash && command -v rg && command -v ps && '
                   '/opt/official/node --version && test -S /opt/benchmark-broker/api.sock && '
                   'test -S /opt/benchmark-dependencies/deps.sock && '
                   'mkdir -p /opt/benchmark-input /logs/agent')
        result = await environment.exec(command, timeout_sec=30)
        if result.return_code:
            raise RuntimeError('native runtime preflight failed before model activation')

    async def run(self, instruction, environment, context):
        global LEDGER
        if BROKER is None:
            raise RuntimeError('broker not configured')
        ledger = LEDGER = Ledger(protocol=PROTOCOL, deferred=True)
        BROKER.ledger = ledger
        context.metadata = {'harness': self.harness}
        forced = None
        resources = None
        async def sample_resources():
            nonlocal resources
            if not hasattr(environment, 'resource_snapshot'):
                return
            while True:
                try:
                    resources = await environment.resource_snapshot()
                    resources['sampled_at_monotonic'] = time.monotonic()
                except Exception:
                    pass  # Missing resource telemetry never becomes a fake 0.
                await asyncio.sleep(3)
        async def watch_deadline():
            nonlocal forced, resources
            while True:
                await asyncio.sleep(.1)
                if ledger.started and (time.monotonic() >= ledger.deadline or ledger.denials):
                    forced = 'BUDGET_LIMIT' if ledger.denials else 'TIMEOUT'
                    ledger.close()
                    # Stop ALL task processes at the common external deadline,
                    # even if the native wrapper is blocked in an RPC/tool.
                    await environment.quiesce()
                    return
        watcher = asyncio.create_task(watch_deadline())
        sampler = asyncio.create_task(sample_resources())
        try:
            with tempfile.TemporaryDirectory(prefix='paired-input-') as temporary:
                path = Path(temporary) / 'input.json'
                path.write_text(json.dumps(dict(PROTOCOL.wire(), capability=ledger.token,
                                                instruction=instruction, start_control=True)))
                path.chmod(0o600)
                await environment.upload_file(path, '/opt/benchmark-input/input.json')
            launcher = 'official_headless.py' if self.harness == 'official' else 'headless.py'
            result = await environment.exec('python3 /opt/bench/' + launcher +
                                            ' < /opt/benchmark-input/input.json', timeout_sec=PROTOCOL.seconds + 45)
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            (self.logs_dir / 'launcher.json').write_text(json.dumps(result.model_dump(), indent=2))
            context.metadata['adapter_exit_code'] = result.return_code
            context.metadata['termination'] = forced or ('TIMEOUT' if result.return_code == 124 else
                                               'COMPLETED' if result.return_code == 0 else 'AGENT_ERROR')
            if result.return_code == 124 or forced == 'TIMEOUT':
                raise AgentTimeoutError('native harness reached shared deadline')
            # Nonzero native agent exit still gets an independent verifier.
        finally:
            ledger.close()
            if not watcher.done() and forced:
                await watcher
            else:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
            sampler.cancel()
            await asyncio.gather(sampler, return_exceptions=True)
            if not forced and hasattr(environment, 'resource_snapshot'):
                try:
                    resources = await environment.resource_snapshot()
                except Exception:
                    pass
            if forced and resources:
                resources['scope'] += '; last pre-termination sample, up to 3 seconds of peak growth may be missing'
            context.metadata['resources'] = resources
            if forced:
                context.metadata['termination'] = forced
            await environment.quiesce()
            report = await asyncio.to_thread(ledger.close, 125)
            context.metadata['broker'] = report
            if report['budget_denials']:
                context.metadata['termination'] = 'BUDGET_LIMIT'
            usage = [row['usage'] for row in report['rows'] if row['usage']]
            context.n_input_tokens = sum(row['prompt_tokens'] for row in usage)
            context.n_output_tokens = sum(row['completion_tokens'] for row in usage)
            context.n_cache_tokens = sum(row.get('prompt_cache_hit_tokens', 0) for row in usage)
            context.cost_usd = None
            if report['inflight']:
                raise RuntimeError('unsettled provider calls; no next trial permitted')


class XHarnessNative(NativeAgent):
    harness = 'xharness'

    @staticmethod
    def name():
        return 'xharness-native-paired'
