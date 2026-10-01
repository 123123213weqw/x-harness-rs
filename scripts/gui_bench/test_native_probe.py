import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.gui_bench.run_native_probe import command, environment


class NativeProbeTests(unittest.TestCase):
    def test_compiled_binary_only_and_linux_owns_its_display(self):
        binary = Path("/fixture/probe")
        self.assertEqual(command(binary, "darwin"), [str(binary)])
        self.assertEqual(command(binary, "win32"), [str(binary)])
        self.assertIn("xvfb-run", command(binary, "linux"))
        self.assertIn("dbus-run-session", command(binary, "linux"))

    def test_no_ambient_credentials_display_or_proxy(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            "PATH": "/bin", "DEEPSEEK_API_KEY": "fake-sensitive", "GH_TOKEN": "fake-token",
            "HTTP_PROXY": "http://fake-sensitive", "DISPLAY": ":0", "XDG_CONFIG_HOME": "/user",
        }, clear=True):
            env = environment(Path(root))
            self.assertEqual(env["PATH"], "/bin")
            for key in ["DEEPSEEK_API_KEY", "GH_TOKEN", "HTTP_PROXY", "DISPLAY"]:
                self.assertNotIn(key, env)
            self.assertEqual(env["XDG_CONFIG_HOME"], str(Path(root) / "config"))
            self.assertTrue(Path(env["XDG_RUNTIME_DIR"]).is_dir())


if __name__ == "__main__":
    unittest.main()
