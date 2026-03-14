import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

HAS_HARBOR = importlib.util.find_spec('harbor') is not None
if HAS_HARBOR:
    os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
    import deepseek_agent
    from paired_environment import EvaluationDocker
    from run_paired import mock_task
    from harbor.models.task.config import TaskConfig, NetworkPolicy
    from harbor.trial.errors import AgentTimeoutError


@unittest.skipUnless(HAS_HARBOR, 'pinned Harbor integration runs on WZU/CI')
class PairedAdapterTests(unittest.IsolatedAsyncioTestCase):
    def test_static_network_policy_fails_closed(self):
        none = NetworkPolicy(network_mode='no-network')
        public = NetworkPolicy(network_mode='public')
        self.assertFalse(EvaluationDocker._requires_egress_control(startup_network_policy=none, phase_network_policies=[none]))
        with self.assertRaises(ValueError):
            EvaluationDocker._requires_egress_control(startup_network_policy=none, phase_network_policies=[public])

    def test_fixture_is_valid_harbor_task(self):
        import tomllib
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'task'
            mock_task(root)
            config = TaskConfig.model_validate(tomllib.loads((root / 'task.toml').read_text()))
            for phase in (config.environment, config.agent, config.verifier):
                self.assertEqual(phase.network_mode.value, 'no-network')

    async def test_both_launchers_quiesce_and_record_timeout(self):
        for cls in (deepseek_agent.NativeAgent, deepseek_agent.XHarnessNative):
            result = SimpleNamespace(return_code=124, model_dump=lambda: {'return_code': 124})
            environment = SimpleNamespace(upload_file=AsyncMock(), exec=AsyncMock(return_value=result), quiesce=AsyncMock())
            context = SimpleNamespace(metadata=None)
            with tempfile.TemporaryDirectory() as directory:
                agent = cls(logs_dir=Path(directory))
                with patch.object(deepseek_agent, 'BROKER', SimpleNamespace(ledger=None)):
                    with self.assertRaises(AgentTimeoutError):
                        await agent.run('fixture', environment, context)
                    environment.quiesce.assert_awaited_once()
                    self.assertEqual(context.metadata['termination'], 'TIMEOUT')
                    self.assertEqual(context.metadata['broker']['inflight'], 0)
                    self.assertEqual(context.metadata['broker']['requests'], 0)
                    deepseek_agent.LEDGER = None
