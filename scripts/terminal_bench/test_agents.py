"""Pinned Harbor adapter checks; skipped on machines without evaluation deps."""
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

HAS_HARBOR = importlib.util.find_spec("harbor") is not None
if HAS_HARBOR:
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    import agents
    from harbor.trial.errors import AgentTimeoutError


@unittest.skipUnless(HAS_HARBOR, "install pinned Harbor on the evaluation host")
class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_deadline_uses_harbor_gradable_error(self):
        result = SimpleNamespace(return_code=124, model_dump=lambda: {"return_code": 124})
        environment = SimpleNamespace(upload_file=AsyncMock(), exec=AsyncMock(return_value=result))
        context = SimpleNamespace(metadata=None)
        with tempfile.TemporaryDirectory() as directory:
            agent = agents.XHarnessAgent(logs_dir=Path(directory))
            with patch.object(agents, "BROKER", SimpleNamespace(url="http://127.0.0.1:1/v1", ledger=None)):
                try:
                    with self.assertRaises(AgentTimeoutError):
                        await agent.run("synthetic fixture", environment, context)
                    self.assertEqual(context.metadata["broker"]["requests"], 0)
                    self.assertEqual(context.metadata["adapter_exit_code"], 124)
                finally:
                    agents.LEDGER = None

    async def test_setup_network_failure_never_activates_model(self):
        environment = SimpleNamespace(exec=AsyncMock(return_value=SimpleNamespace(return_code=1)))
        with tempfile.TemporaryDirectory() as directory:
            agent = agents.XHarnessAgent(logs_dir=Path(directory))
            with patch.object(agents, "activate") as activate:
                with self.assertRaisesRegex(RuntimeError, "before model activation"):
                    await agent.setup(environment)
                activate.assert_not_called()
