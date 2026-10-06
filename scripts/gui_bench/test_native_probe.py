import os
import errno
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.gui_bench.run_native_probe import command, environment, cleanup, cleanup_profile, hard_capabilities, contract_completed, core_native_apis_passed, native_coordinates_verified


class NativeProbeTests(unittest.TestCase):
    def test_macos_geometry_uses_webkit_public_automatic_inset_conditions(self):
        root=Path(__file__).resolve().parents[2]
        native=(root/'apps/desktop/src-tauri/examples/native_api/macos.rs').read_text()
        for source in ('NSWindowStyleMask::FullSizeContentView', '!window.titlebarAppearsTransparent()',
                       'view.enclosingScrollView().is_none()', 'window.updateConstraintsIfNeeded()',
                       'view.convertRect_fromView(window.contentLayoutRect(), None)', 'content_point(x, y, height, flipped, top)?'):
            self.assertIn(source, native)
        # Never compensate an observed 28px discrepancy with a magic constant or SPI.
        implementation=native.split('#[cfg(test)]')[0]
        self.assertNotIn('28.0', implementation)
        self.assertNotIn('_topContentInset', implementation)
        self.assertIn('--macos-titlebar overlay', (root/'.github/workflows/ci.yml').read_text())

    def test_macos_probe_targets_owned_native_responder_and_observes_focus(self):
        root=Path(__file__).resolve().parents[2]/'apps/desktop/src-tauri/examples'
        native=(root/'native_api/macos.rs').read_text()
        for action in ('mouseDown','mouseUp','keyDown','keyUp'):
            self.assertIn('view.'+action+'(&event)',native)
        self.assertNotIn('window.sendEvent(&event)',native)
        self.assertIn('view.isHiddenOrHasHiddenAncestor()',native)
        self.assertIn('window.makeFirstResponder(Some(view))',native)
        self.assertIn('NSProcessInfo::processInfo().systemUptime()',native)
        self.assertNotIn('dispatchEvent',native.replace('// NSEvent/WebKit native input path, never DOM dispatchEvent or OS input.',''))
        source=(root/'browser-inspect-probe.rs').read_text()
        self.assertIn("document.activeElement?.id === 'answer'",source)
        self.assertIn('input_error.is_none() && focus_observed',source)
        self.assertIn('Duration::from_secs(2)',source)

    def test_core_api_gate_requires_trusted_state_and_changed_pixels(self):
        api = dict(status='tested', native_mouse={'passed':True}, native_keyboard={'passed':True},
            cross_origin_pointer={'passed':True}, snapshot_sequence_verified=True,
            observed={'pointers':[dict(type='click',trusted=True,id=target,x=x,y=y)
                for target,x,y in [('native-probe',450,120),('answer',60,35)]]})
        self.assertTrue(core_native_apis_passed(api))
        self.assertFalse(core_native_apis_passed({}))
        for name in ('native_mouse','native_keyboard','cross_origin_pointer'):
            for value in ({'passed':False}, {'passed':1}, {}, None):
                self.assertFalse(core_native_apis_passed(dict(api, **{name:value})))
        self.assertFalse(core_native_apis_passed(dict(api, snapshot_sequence_verified=False)))
        self.assertFalse(core_native_apis_passed(dict(api, status='unverified')))
        self.assertFalse(core_native_apis_passed(dict(api, observed={})))

    def test_native_pointer_coordinates_are_independently_checked_and_bounded(self):
        events=[dict(type='click',trusted=True,id=target,x=x,y=y)
                for target,x,y in [('native-probe',450,120),('answer',60,35)]]
        def checked(items): return native_coordinates_verified({'observed':{'pointers':items}})
        self.assertTrue(checked(events))
        for axis in ('x','y'):
            for value in (None, True, '120', float('nan'), float('inf'), -1, 92):
                self.assertFalse(checked([dict(events[0],**{axis:value}),events[1]]))
        for key,value in [('type','mousedown'),('trusted',False),('id','wrong')]:
            self.assertFalse(checked([dict(events[0],**{key:value}),events[1]]))
        self.assertFalse(checked(events * 16))
        self.assertFalse(checked(events[:1]))
        for invalid in (None,{},[],{'observed':None},{'observed':{'pointers':'fake'}}):
            self.assertFalse(native_coordinates_verified(invalid if isinstance(invalid,dict) else {}))

    def test_all_gui_entry_points_prepare_x11_before_tauri_initialization(self):
        root = Path(__file__).resolve().parents[2] / 'apps/desktop/src-tauri'
        for relative in ['src/lib.rs','examples/browser-inspect-probe.rs','examples/native-browser-bench.rs']:
            source=(root/relative).read_text()
            self.assertLess(source.index('native_startup::prepare()'),source.index('tauri::Builder::default()'))
        source=(root/'src/native_startup.rs').read_text()
        self.assertIn('std::env::var_os("DISPLAY").is_some()',source)
        self.assertIn('(xlib.XInitThreads)()',source)
        self.assertNotIn('XOpenDisplay',source)

    def test_early_zero_exit_or_partial_pass_is_not_acceptance(self):
        import json
        self.assertFalse(contract_completed(""))
        self.assertFalse(contract_completed("Native lifecycle probe passed:"))
        self.assertFalse(contract_completed("Native observation probe failed: native open did not reach ready"))
        evidence = {name: {"status": "not_implemented"} for name in [
            "trusted_input", "cross_origin_frames", "screenshot", "recording", "hidden_tab_actions"]}
        log = "Native lifecycle probe passed:\nNative Tauri DOM probe passed:\nHARD_CAPABILITY_EVIDENCE " + json.dumps(evidence)
        self.assertTrue(contract_completed(log))
        self.assertFalse(contract_completed(log + "\nNative observation probe failed:"))

    def test_capability_evidence_is_not_inferred_from_dom_pass_or_silent_skip(self):
        import json
        for log in ["Native Tauri DOM probe passed", "HARD_CAPABILITY_EVIDENCE {}",
                    "HARD_CAPABILITY_EVIDENCE not-json"]:
            self.assertEqual(hard_capabilities(log)["status"], "unverified")
        evidence = {name: {"status": "not_implemented"} for name in [
            "trusted_input", "cross_origin_frames", "screenshot", "recording", "hidden_tab_actions"]}
        line = "HARD_CAPABILITY_EVIDENCE " + json.dumps(evidence)
        self.assertEqual(hard_capabilities(line), evidence)
        self.assertEqual(hard_capabilities(line + "\n" + line)["status"], "unverified")

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

    def test_gnome_gvfs_cleanup_is_limited_to_exact_owned_runtime_mount(self):
        with tempfile.TemporaryDirectory(prefix="xh-webview-profile-") as directory:
            root = Path(directory)
            for suffix, code, allowed in [("runtime/gvfs",0,True), ("runtime/gvfs",1,False),
                                          ("runtime/foreign",0,False), ("other/gvfs",0,False)]:
                target = root / suffix
                mounts = (f"1 2 0:3 / {target} rw - fuse.gvfsd-fuse gvfsd-fuse rw\n"
                          "4 5 0:6 / /user/runtime/gvfs rw - fuse.gvfsd-fuse gvfsd-fuse rw\n")
                with patch("scripts.gui_bench.run_native_probe.Path.exists", return_value=True), \
                     patch("scripts.gui_bench.run_native_probe.Path.read_text", return_value=mounts), \
                     patch("scripts.gui_bench.run_native_probe.subprocess.run", return_value=SimpleNamespace(returncode=code)) as process, \
                     patch("scripts.gui_bench.run_native_probe.cleanup", return_value=True) as remove:
                    self.assertEqual(cleanup_profile(root),allowed)
                    self.assertEqual(process.call_count,int(suffix=="runtime/gvfs"))
                    if allowed:
                        process.assert_called_once_with(["fusermount3","-uz",str(target)],capture_output=True,timeout=5)
                        remove.assert_called_once_with(root)
                    else: remove.assert_not_called()

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
        manifest = ET.parse(root / "windows-common-controls.manifest")
        identity = manifest.find(".//{urn:schemas-microsoft-com:asm.v1}dependentAssembly/{urn:schemas-microsoft-com:asm.v1}assemblyIdentity")
        self.assertEqual(identity.attrib["name"], "Microsoft.Windows.Common-Controls")
        self.assertEqual(identity.attrib["version"], "6.0.0.0")
        requested = manifest.find(".//{urn:schemas-microsoft-com:asm.v3}requestedExecutionLevel")
        self.assertIsNone(requested) # Never override production privilege policy.
        build = (root / "build.rs").read_text()
        self.assertIn("rustc-link-arg=/MANIFEST:EMBED", build)
        self.assertIn("rustc-link-arg=/MANIFESTINPUT:", build)
        self.assertNotIn("rustc-link-arg-bins=/MANIFEST", build)
        self.assertIn('WindowsAttributes::new_without_app_manifest()', build)


if __name__ == "__main__":
    unittest.main()
