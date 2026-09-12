from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
from health import check_dependencies


class HealthTests(unittest.IsolatedAsyncioTestCase):
    async def test_pass(self):
        env = SimpleNamespace(exec=AsyncMock(return_value=SimpleNamespace(return_code=0)))
        await check_dependencies(env)
        self.assertEqual(env.exec.call_args.kwargs["timeout_sec"], 25)

    async def test_failure_is_not_ignored(self):
        env = SimpleNamespace(exec=AsyncMock(return_value=SimpleNamespace(return_code=1)))
        with self.assertRaisesRegex(RuntimeError, "before model activation"):
            await check_dependencies(env)

    async def test_timeout_is_bounded_and_sanitized(self):
        env = SimpleNamespace(exec=AsyncMock(side_effect=TimeoutError("private output")))
        with self.assertRaisesRegex(RuntimeError, "before model activation") as raised:
            await check_dependencies(env)
        self.assertNotIn("private output", str(raised.exception))
