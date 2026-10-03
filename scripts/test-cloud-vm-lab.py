#!/usr/bin/env python3
"""Offline guard tests. They do not launch VMs or compile Rust."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("cloud_vm_lab", Path(__file__).with_name("cloud-vm-lab.py"))
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


class Guards(unittest.TestCase):
    def bare(self, root):
        item = object.__new__(lab.Lab)
        item.root = Path(root)
        return item

    def test_atomic_report_has_no_temporary_residue(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            lab.atomic_json(path, {"revision": 1})
            lab.atomic_json(path, {"revision": 2})
            self.assertEqual(json.loads(path.read_text()), {"revision": 2})
            self.assertFalse(path.with_suffix(".json.tmp").exists())

    def test_unknown_platform_and_root_are_rejected_before_effects(self):
        with patch.object(lab.sys, "platform", "darwin"):
            with self.assertRaisesRegex(RuntimeError, "unprivileged Linux"):
                lab.Lab("/unrelated")
        with patch.object(lab.sys, "platform", "linux"), patch.object(lab.os, "getuid", return_value=0):
            with self.assertRaisesRegex(RuntimeError, "unprivileged Linux"):
                lab.Lab("/unrelated")

    def test_sandbox_does_not_bind_home_gpu_or_another_vm(self):
        obj = self.bare("/authorized/lab")
        args = obj.sandbox({"name": "vm-1"})
        self.assertIn("--unshare-pid", args)
        self.assertIn("--unshare-user", args)
        self.assertIn("/authorized/lab/vm-1", args)
        self.assertIn("/dev/kvm", args)
        self.assertNotIn("/dev/nvidia0", args)
        self.assertNotIn(str(Path.home()), args)
        self.assertNotIn("/authorized/lab/vm-2", args)
        self.assertIn("--die-with-parent", args)

    def test_ssh_requires_pinned_host_key_and_no_forwarded_agent(self):
        args = self.bare("/lab").ssh_command({"ssh_port": 24000}, "true")
        self.assertIn("StrictHostKeyChecking=yes", args)
        self.assertIn("IdentityAgent=none", args)
        self.assertIn("ForwardAgent=no", args)
        self.assertIn("HostKeyAlgorithms=ssh-ed25519", args)
        self.assertNotIn("StrictHostKeyChecking=no", args)

    def test_active_or_paused_guest_cannot_be_a_stop_proof(self):
        obj = self.bare("/lab")
        for status in ("active", "activating", "deactivating"):
            obj.unit_info = lambda _: {"ActiveState": status, "MainPID": "123"}
            self.assertFalse(obj.stopped({}))

    def test_no_socket_is_not_enough_if_unit_still_has_main_pid(self):
        obj = self.bare("/lab")
        obj.unit_info = lambda _: {"ActiveState": "failed", "MainPID": "123"}
        self.assertFalse(obj.stopped({}))

    def test_stop_refuses_other_unit_before_signalling(self):
        obj = self.bare("/authorized/lab")
        obj.unit_info = lambda _: {"ActiveState": "active", "ExecStart": "/unrelated/qemu"}
        with patch.object(lab, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "not owned"):
                obj.stop({"name": "vm-1"})
            run.assert_not_called()

    def test_duplicate_start_cannot_dispatch(self):
        obj = self.bare("/lab")
        obj.unit_info = lambda _: {"ActiveState": "active"}
        with patch.object(lab, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "duplicate start"):
                obj.start({})
            run.assert_not_called()

    def test_error_output_does_not_echo_secret_stdin(self):
        with self.assertRaises(RuntimeError) as caught:
            lab.run(["/usr/bin/false"], input=b"private-key-value")
        self.assertNotIn("private-key-value", str(caught.exception))

    def test_port_collision_is_not_automatically_reassigned(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            with self.assertRaises(OSError):
                lab.free_ports([occupied.getsockname()[1]])

    def test_active_listener_is_refused_even_with_reuseaddr(self):
        with socket.socket() as occupied:
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            occupied.bind(("127.0.0.1", 0))
            occupied.listen(1)
            with self.assertRaises(OSError):
                lab.free_ports([occupied.getsockname()[1]])

    def test_time_wait_does_not_falsely_report_a_live_vm(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            address = server.getsockname()
            server.listen(1)
            with socket.create_connection(address) as peer:
                accepted, _ = server.accept()
                accepted.shutdown(socket.SHUT_WR)
                self.assertEqual(peer.recv(1), b"")
                peer.close()
                accepted.close()
        lab.free_ports([address[1]])

    def test_routes_use_frozen_title_projection_not_top_level_title(self):
        obj = self.bare("/lab")
        obj.rpc = lambda *_: {"items": [{"sessionId": lab.SESSION,
                                        "projections": {"values": {"title": "vm-1"}}}]}
        self.assertEqual(obj.routes([{"name": "vm-1"}]), ["vm-1"])

    def test_connection_switch_rejects_another_vms_title(self):
        obj = self.bare("/lab")
        obj.rpc = lambda *_: {"items": [{"sessionId": lab.SESSION,
                                        "projections": {"values": {"title": "vm-2"}}}]}
        with self.assertRaisesRegex(RuntimeError, "another environment"):
            obj.routes([{"name": "vm-1"}])

    def test_qmp_accepts_fragmented_frames_and_skips_events(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "qmp"
            errors = []
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(path))
                server.listen(1)

                def peer():
                    try:
                        client, _ = server.accept()
                        with client, client.makefile("rwb") as stream:
                            greeting = json.dumps({"QMP": {"version": {}}}).encode() + b"\n"
                            for part in greeting:
                                stream.write(bytes([part])); stream.flush()
                            for index in range(2):
                                request = json.loads(stream.readline())
                                self.assertEqual(request["id"], index)
                                stream.write(b'{"event":"STOP"}\n')
                                response = {} if index == 0 else {"status": "paused"}
                                stream.write((json.dumps({"id": index, "return": response}) + "\n").encode())
                                stream.flush()
                    except BaseException as error:
                        errors.append(error)

                thread = threading.Thread(target=peer)
                thread.start()
                self.assertEqual(lab.qmp(path, "query-status"), {"status": "paused"})
                thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
