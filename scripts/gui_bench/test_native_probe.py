import os
import errno
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.gui_bench.run_native_probe import command, environment, cleanup


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

    def test_cleanup_retries_transient_writers_but_never_hides_failure(self):
        with patch("scripts.gui_bench.run_native_probe.shutil.rmtree", side_effect=[OSError(errno.ENOTEMPTY, "writer"), None]) as remove, patch("scripts.gui_bench.run_native_probe.time.sleep"):
            self.assertTrue(cleanup(Path("/owned-probe")))
            self.assertEqual(remove.call_count, 2)
        with patch("scripts.gui_bench.run_native_probe.shutil.rmtree", side_effect=PermissionError()), patch("scripts.gui_bench.run_native_probe.time.sleep"):
            self.assertFalse(cleanup(Path("/owned-probe")))

    def test_windows_probe_embeds_common_controls_without_elevating_or_changing_app(self):
        import xml.etree.ElementTree as ET
        root = Path(__file__).resolve().parents[2] / "apps/desktop/src-tauri"
        manifest = ET.parse(root / "examples/browser-inspect-probe.manifest")
        identity = manifest.find(".//{urn:schemas-microsoft-com:asm.v1}dependentAssembly/{urn:schemas-microsoft-com:asm.v1}assemblyIdentity")
        self.assertEqual(identity.attrib["name"], "Microsoft.Windows.Common-Controls")
        self.assertEqual(identity.attrib["version"], "6.0.0.0")
        requested = manifest.find(".//{urn:schemas-microsoft-com:asm.v3}requestedExecutionLevel")
        self.assertEqual(requested.attrib, {"level":"asInvoker", "uiAccess":"false"})
        build = (root / "build.rs").read_text()
        self.assertIn("rustc-link-arg-examples=/MANIFEST:EMBED", build)
        self.assertIn("rustc-link-arg-examples=/MANIFESTINPUT:", build)
        self.assertNotIn("rustc-link-arg-bins=/MANIFEST", build)


if __name__ == "__main__":
    unittest.main()
