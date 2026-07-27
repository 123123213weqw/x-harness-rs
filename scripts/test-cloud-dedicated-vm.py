#!/usr/bin/env python3
"""Offline dedicated-environment guards; no VM or network effects."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dedicated", Path(__file__).with_name("cloud-dedicated-vm.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeLab:
    def __init__(self, root):
        self.root = Path(root)
        self.manifest = {"lab_id": "test-lab", "vms": [
            {"name": f"vm-{i}", "uuid": f"identity-{i}", "unit": f"unit-{i}", "cpus": [2*i, 2*i+1]}
            for i in range(1,5)]}
        self.active=False; self.starts=[]; self.stops=[]
        disk=self.root / "vm-1/disk.qcow2"; disk.parent.mkdir(); disk.write_bytes(b"disk")
        base=self.root / "images/base.img"; base.parent.mkdir(); base.write_bytes(b"base")
        (base.parent / "verified.json").write_text(json.dumps({"sha256": module.lab_module.digest(base)}))
    def stopped(self, vm): return not self.active if vm["name"] == "vm-1" else True
    def unit_info(self, vm): return {"ActiveState": "active" if self.active else "inactive"}
    def start(self, vm, *, runtime_max_seconds): self.starts.append(runtime_max_seconds); self.active=True
    def stop(self, vm): self.stops.append(vm["uuid"]); self.active=False
    def ready(self, vm): return None
    def qmp(self, vm, action): return {"UUID": vm["uuid"]}
    def check_caps(self, vm): return {"memory_max": module.lab_module.HOST_MEMORY_MAX}

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.lab=FakeLab(self.temp.name)
        self.patcher=patch.object(module.lab_module,"run",return_value=json.dumps({"format":"qcow2", "virtual-size":16*1024**3})); self.patcher.start(); self.addCleanup(self.patcher.stop)
        self.item=module.Dedicated(self.lab)
    def promote(self): self.item.promote()
    def seed_unknown(self):
        self.promote(); self.lab.start=lambda *a,**kw: (_ for _ in ()).throw(RuntimeError("lost reply"))
        with self.assertRaises(RuntimeError): self.item.operate("start","unknown")
    def test_promotion_reuses_existing_identity_disk_and_does_not_start(self):
        first=self.item.promote(); second=module.Dedicated(self.lab).promote()
        self.assertEqual(first,second); self.assertEqual(first["instance_id"],"identity-1"); self.assertFalse(self.lab.starts)
    def test_promotion_requires_verified_stop_before_effects(self):
        self.lab.active=True
        with self.assertRaisesRegex(RuntimeError,"stop all"): self.item.promote()
        self.assertFalse(self.item.path.exists())
    def test_dedicated_start_has_explicit_lifetime_and_keeps_resource_caps(self):
        self.promote(); receipt=self.item.operate("start","start1")
        self.assertEqual(receipt["status"],"applied"); self.assertEqual(self.lab.starts,[0])
        self.assertEqual(self.item.environment["resources"]["qemu_memory_max_bytes"],4*1024**3)
        self.assertFalse(self.item.environment["resources"]["cpu_quota_verified"])
    def test_replayed_start_is_historical_even_after_later_stop(self):
        self.promote(); self.item.operate("start","start1"); self.item.operate("stop","stop1")
        self.item.operate("start","start1")
        self.assertEqual(self.lab.starts,[0]); self.assertFalse(self.lab.active)
    def test_unknown_operation_is_queried_without_redispatch(self):
        self.seed_unknown(); self.lab.starts.clear()
        result=module.Dedicated(self.lab).operate("start","unknown")
        self.assertEqual(result["status"],"needs_reconcile"); self.assertFalse(self.lab.starts)
    def test_unknown_start_cannot_be_hidden_by_new_identity(self):
        self.seed_unknown()
        with self.assertRaisesRegex(RuntimeError,"unresolved"): self.item.operate("start","other")
    def test_verified_stop_retains_unknown_outcome_tombstone(self):
        self.seed_unknown(); self.item.operate("stop","stop1")
        prior=json.loads((self.item.operations / "unknown.json").read_text())
        self.assertEqual(prior["status"],"quiesced_outcome_unknown"); self.assertEqual(prior["quiesced_by"],"stop1")
        replay=self.item.operate("start","unknown")
        self.assertEqual(replay,prior)
        self.assertTrue((self.lab.root / "vm-1/disk.qcow2").exists())
    def test_request_id_conflict_rejected_without_second_effect(self):
        self.promote(); self.item.operate("start","one")
        with self.assertRaisesRegex(RuntimeError,"conflicting"): self.item.operate("stop","one")
        self.assertFalse(self.lab.stops)
    def test_wrong_vm_uuid_never_returns_applied(self):
        self.promote(); self.lab.qmp=lambda *a:{"UUID":"different"}
        with self.assertRaisesRegex(RuntimeError,"UUID"): self.item.operate("start","one")
        self.assertEqual(json.loads((self.item.operations / "one.json").read_text())["status"],"needs_reconcile")
    def test_manifest_identity_cannot_be_changed_on_reopen(self):
        self.promote(); self.item.environment["volume_id"]="another"
        self.item.path.write_text(json.dumps(self.item.environment))
        with self.assertRaisesRegex(RuntimeError,"identity changed"): module.Dedicated(self.lab)
    def test_invalid_or_path_operation_ids_are_rejected(self):
        self.promote()
        for value in [None,"../one","/tmp/file",".hidden","","x"*129]:
            with self.assertRaisesRegex(RuntimeError,"identity"): self.item.operate("start",value)
        self.assertFalse(self.lab.starts)
    def test_status_does_not_claim_host_gate_or_model_are_ready(self):
        self.promote(); result=self.item.status()
        self.assertEqual(result["environment"]["host_task_recovery_gate"],"not_integrated")
        self.assertEqual(result["environment"]["model_reachable"],"unverified")
    def test_applied_stop_replay_finishes_tombstone_after_write_failure(self):
        self.seed_unknown()
        original=module.lab_module.atomic_json
        def interrupted(path,value):
            if path.name=="unknown.json" and value["status"]=="quiesced_outcome_unknown":
                raise OSError("simulated disk failure")
            original(path,value)
        with patch.object(module.lab_module,"atomic_json",side_effect=interrupted):
            with self.assertRaises(OSError): self.item.operate("stop","stop1")
        stop_path=self.item.operations / "stop1.json"
        self.assertEqual(json.loads(stop_path.read_text())["status"],"applied")
        self.assertEqual(json.loads(stop_path.read_text())["quiesces"],["unknown"])
        reopened=module.Dedicated(self.lab); reopened.operate("stop","stop1")
        self.assertEqual(json.loads((self.item.operations / "unknown.json").read_text())["status"],"quiesced_outcome_unknown")
        self.assertEqual(self.lab.stops,["identity-1"])
    def test_old_stop_replay_never_quiesces_later_uncertain_start(self):
        self.promote(); self.item.operate("stop","oldstop")
        self.seed_unknown(); self.item.operate("stop","oldstop")
        self.assertEqual(json.loads((self.item.operations / "unknown.json").read_text())["status"],"needs_reconcile")
        self.assertEqual(self.lab.stops,["identity-1"])
    def test_foreign_receipt_key_or_payload_rejects_before_effects(self):
        self.promote(); self.item.operate("start","one"); self.item.operate("stop","stop1")
        one=json.loads((self.item.operations / "one.json").read_text())
        (self.item.operations / "different.json").write_text(json.dumps(one))
        with self.assertRaisesRegex(RuntimeError,"identity or state"): self.item.operate("start","different")
        self.assertEqual(self.lab.starts,[0])
        (self.item.operations / "different.json").unlink()
        one["payload"]["instance_id"]="foreign"
        (self.item.operations / "one.json").write_text(json.dumps(one))
        with self.assertRaisesRegex(RuntimeError,"identity or state"): self.item.operate("start","newstart")
        self.assertEqual(self.lab.starts,[0])
    def test_symlinked_environment_or_receipt_directory_is_rejected(self):
        self.promote()
        self.item.path.unlink(); self.item.path.symlink_to(self.lab.root / "images/verified.json")
        with self.assertRaisesRegex(RuntimeError,"symlink"): module.Dedicated(self.lab)
        self.item.path.unlink(); self.item.operations.rmdir()
        self.item.operations.symlink_to(self.lab.root / "images",target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError,"symlink"): module.Dedicated(self.lab)

if __name__ == "__main__": unittest.main()
