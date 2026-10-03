import os
import errno
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.gui_bench.run_native_probe import command, environment, cleanup, cleanup_profile


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

    def test_profile_cleanup_detaches_only_owned_portal_mounts_before_removal(self):
        with tempfile.TemporaryDirectory(prefix="xh-native-dom-with space-") as directory:
            root = Path(directory)
            target = root / "runtime/doc"
            escaped = str(target).replace(" ", "\\040")
            mounts = (f"1 2 0:3 / {escaped} rw - fuse.portal portal rw\n"
                      "4 5 0:6 / /user/runtime/doc rw - fuse.portal portal rw\n")
            calls = []
            def unmount(*args, **kwargs):
                calls.append("unmount")
                return SimpleNamespace(returncode=0)
            with patch("scripts.gui_bench.run_native_probe.Path.exists", return_value=True), \
                 patch("scripts.gui_bench.run_native_probe.Path.read_text", return_value=mounts), \
                 patch("scripts.gui_bench.run_native_probe.subprocess.run", side_effect=unmount) as process, \
                 patch("scripts.gui_bench.run_native_probe.cleanup", side_effect=lambda _: calls.append("remove") or True):
                self.assertTrue(cleanup_profile(root))
                process.assert_called_once_with(["fusermount3", "-uz", str(target)], capture_output=True, timeout=5)
                self.assertEqual(calls, ["unmount", "remove"])

    def test_portal_unmount_failure_and_other_mounts_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix="xh-native-dom-") as directory:
            root = Path(directory)
            for filesystem, code in [("fuse.portal", 1), ("ext4", 0), ("fuse.other", 0)]:
                mounts = f"1 2 0:3 / {root}/runtime/doc rw - {filesystem} portal rw\n"
                with patch("scripts.gui_bench.run_native_probe.Path.exists", return_value=True), \
                     patch("scripts.gui_bench.run_native_probe.Path.read_text", return_value=mounts), \
                     patch("scripts.gui_bench.run_native_probe.subprocess.run", return_value=SimpleNamespace(returncode=code)) as process, \
                     patch("scripts.gui_bench.run_native_probe.cleanup") as remove:
                    self.assertFalse(cleanup_profile(root))
                    remove.assert_not_called()
                    self.assertEqual(process.call_count, int(filesystem == "fuse.portal"))

    def test_profile_cleanup_rejects_user_relative_outside_temp_and_symlink_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            link = Path(directory) / "xh-native-dom-symlink"
            link.symlink_to(directory, target_is_directory=True)
            with patch("scripts.gui_bench.run_native_probe.subprocess.run") as process, \
                 patch("scripts.gui_bench.run_native_probe.cleanup") as remove:
                for root in [Path("/user/profile"), Path("xh-native-dom-relative"),
                             Path("/user/xh-native-dom-fake"), link]:
                    self.assertFalse(cleanup_profile(root))
                process.assert_not_called()
                remove.assert_not_called()

    def test_no_mount_table_platform_still_requires_real_directory_cleanup(self):
        for prefix in ["xh-native-dom-", "xh-webview-profile-"]:
            with tempfile.TemporaryDirectory(prefix=prefix) as directory, \
                 patch("scripts.gui_bench.run_native_probe.Path.exists", return_value=False):
                self.assertTrue(cleanup_profile(Path(directory)))
                self.assertFalse(Path(directory).is_dir())

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
