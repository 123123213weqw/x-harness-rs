#!/usr/bin/env python3
"""Promote only lab VM 1 into a retained, manual-start dedicated test environment.

Reuses the audited KVM/bwrap/resource/SSH boundaries. This is an operational VM
adapter, NOT Host execution fencing or permission to resume a cancelled task.
Never inject credentials, enable public ports, grant broad egress or delete disks.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import time

spec = importlib.util.spec_from_file_location("cloud_vm_lab", Path(__file__).with_name("cloud-vm-lab.py"))
lab_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab_module)

SCHEMA = "xharness-dedicated-vm/v1"
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def safe_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise RuntimeError("invalid operation identity")
    return value


class Dedicated:
    def __init__(self, lab):
        self.lab = lab
        if not lab.manifest:
            raise RuntimeError("existing four-VM lab is required; do not create another VM")
        self.vm = lab.manifest["vms"][0]
        self.root = lab.root / "dedicated"
        if self.root.is_symlink():
            raise RuntimeError("dedicated state cannot be a symlink")
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.root.chmod(0o700)
        self.path = self.root / "environment.json"
        self.operations = self.root / "operations"
        if self.operations.is_symlink() or self.path.is_symlink():
            raise RuntimeError("dedicated state cannot be a symlink")
        self.operations.mkdir(mode=0o700, exist_ok=True)
        if self.path.exists():
            self.environment = json.loads(self.path.read_text())
            self.validate()
        else:
            self.environment = None

    def validate(self):
        env = self.environment
        if (env.get("schema") != SCHEMA or env.get("instance_id") != self.vm["uuid"]
                or env.get("volume_id") != f"lab-volume-{self.vm['uuid']}"
                or env.get("lab_id") != self.lab.manifest["lab_id"]
                or env.get("unit") != self.vm["unit"] or env.get("execution_epoch") != "1"
                or env.get("disk") != str(self.lab.root / self.vm["name"] / "disk.qcow2")):
            raise RuntimeError("dedicated environment identity changed; refusing adoption")
        if env.get("retention") != "keep_until_explicit_deletion" or env.get("start_policy") != "manual":
            raise RuntimeError("unrecognized retention/start policy")

    def promote(self):
        if self.environment:
            return self.environment
        if not all(self.lab.stopped(vm) for vm in self.lab.manifest["vms"]):
            raise RuntimeError("stop all experiment VMs before promotion")
        disk = self.lab.root / self.vm["name"] / "disk.qcow2"
        if disk.is_symlink() or not disk.is_file():
            raise RuntimeError("persistent disk missing or redirected")
        info = json.loads(lab_module.run(["qemu-img", "info", "--output=json", str(disk)]))
        if info.get("format") != "qcow2" or info.get("virtual-size") != lab_module.DISK_GIB * 1024**3:
            raise RuntimeError("unexpected disk format or capacity")
        base = self.lab.root / "images/base.img"
        verification = json.loads((base.parent / "verified.json").read_text())
        if lab_module.digest(base) != verification["sha256"]:
            raise RuntimeError("base image fingerprint changed")
        # An internal volume identity, not a claim about filesystem UUID/quota.
        env = {"schema": SCHEMA, "environment_id": "v100-dedicated-1", "version": "v1",
               "lab_id": self.lab.manifest["lab_id"], "instance_id": self.vm["uuid"],
               "volume_id": f"lab-volume-{self.vm['uuid']}", "execution_epoch": "1",
               "disk": str(disk), "unit": self.vm["unit"],
               "created_at_ms": str(int(time.time() * 1000)),
               "start_policy": "manual", "host_reboot_policy": "remain_stopped_until_explicit_start",
               "stop_policy": "external_verified_stop_keep_disk",
               "retention": "keep_until_explicit_deletion", "network_policy": "deny_egress_loopback_ingress_only",
               "resources": {"guest_ram_mib": lab_module.GUEST_RAM_MIB, "qemu_memory_max_bytes": lab_module.HOST_MEMORY_MAX,
                             "swap_max_bytes": 0, "pids_max": 128, "cpu_affinity": self.vm["cpus"],
                             "vcpu": 2, "guest_disk_virtual_gib": lab_module.DISK_GIB,
                             "cpu_quota_verified": False, "host_disk_quota_verified": False},
               "host_task_recovery_gate": "not_integrated", "model_reachable": "unverified"}
        lab_module.atomic_json(self.path, env)
        self.environment = env
        return env

    def status(self):
        if not self.environment:
            raise RuntimeError("promote the existing VM first")
        info = self.lab.unit_info(self.vm)
        stopped = self.lab.stopped(self.vm)
        active = info.get("ActiveState") == "active"
        caps = self.lab.check_caps(self.vm) if active else None
        return {"environment": self.environment, "externally_verified_stopped": stopped,
                "active": active, "unit_state": info.get("ActiveState"), "resource_probe": caps,
                "task_execution": "unconfigured; VM running does not imply task permission"}

    def operate(self, method, operation_id):
        if not self.environment or method not in ("start", "stop"):
            raise RuntimeError("promoted environment and supported method are required")
        operation_id = safe_id(operation_id)
        payload = {"method": method, "instance_id": self.environment["instance_id"],
                   "volume_id": self.environment["volume_id"], "execution_epoch": "1"}
        signature = fingerprint(payload)
        path = self.operations / f"{operation_id}.json"
        if path.is_symlink():
            raise RuntimeError("operation receipt cannot be a symlink")
        if path.exists():
            receipt = self.read_receipt(path)
            if receipt.get("fingerprint") != signature:
                raise RuntimeError("same operation ID has conflicting content")
            if receipt.get("status") in ("applied", "quiesced_outcome_unknown"):
                if method == "stop" and receipt["status"] == "applied":
                    self.quiesce_prior(receipt)
                return receipt  # historical receipt, not a new start command
            # Never dispatch a recorded/uncertain request again. Query first.
            result = self.inspect(path, receipt)
            if method == "stop" and result["status"] == "applied":
                self.quiesce_prior(result)
            return result
        unresolved = [p for p in self.operations.glob("*.json")
                      if self.read_receipt(p)["status"] in ("pending", "needs_reconcile")]
        if unresolved and method == "start":
            raise RuntimeError("unresolved VM operation must be reconciled before another start")
        receipt = {"schema": SCHEMA, "operation_id": operation_id,
                   "fingerprint": signature, "payload": payload, "status": "pending"}
        if method == "stop":
            # Persist the exact predecessor set before stopping. Replaying an
            # old stop may repair this set, but must never seal later operations.
            receipt["quiesces"] = [p.stem for p in unresolved]
        lab_module.atomic_json(path, receipt)
        try:
            if method == "start":
                # RuntimeMaxSec=infinity means explicit lifetime, NOT restarting work or
                # auto-starting at host boot. All hard memory/pids caps stay.
                if self.lab.unit_info(self.vm).get("ActiveState") != "active":
                    self.lab.start(self.vm, runtime_max_seconds=0)
                self.lab.ready(self.vm)
            else:
                self.lab.stop(self.vm)
            result = self.inspect(path, receipt)
            if method == "stop" and result["status"] == "applied":
                self.quiesce_prior(result)
            return result
        except Exception:
            # Once a verified proof was persisted, failure repairing a prior
            # tombstone must not erase it. Reopen/replay can finish that repair.
            if receipt["status"] != "applied":
                receipt["status"] = "needs_reconcile"
                lab_module.atomic_json(path, receipt)
            raise

    def read_receipt(self, path):
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("operation receipt must be a regular file")
        receipt = json.loads(path.read_text())
        payload = receipt.get("payload", {})
        expected = {"method": payload.get("method"), "instance_id": self.vm["uuid"],
                    "volume_id": self.environment["volume_id"], "execution_epoch": "1"}
        if (receipt.get("schema") != SCHEMA or receipt.get("operation_id") != path.stem
                or safe_id(path.stem) != path.stem or payload != expected
                or payload["method"] not in ("start", "stop")
                or receipt.get("fingerprint") != fingerprint(payload)
                or receipt.get("status") not in ("pending", "needs_reconcile", "applied", "quiesced_outcome_unknown")):
            raise RuntimeError("operation receipt identity or state changed")
        predecessors = receipt.get("quiesces", [])
        if not isinstance(predecessors, list) or len(set(predecessors)) != len(predecessors):
            raise RuntimeError("invalid predecessor identities")
        for predecessor in predecessors:
            if safe_id(predecessor) == path.stem:
                raise RuntimeError("operation cannot quiesce itself")
        if predecessors and payload["method"] != "stop":
            raise RuntimeError("only external stop can quiesce predecessors")
        if receipt["status"] == "quiesced_outcome_unknown":
            safe_id(receipt.get("quiesced_by"))
        return receipt

    def quiesce_prior(self, receipt):
        if receipt["payload"]["method"] != "stop" or receipt["status"] != "applied":
            raise RuntimeError("verified stop receipt is required")
        # Legacy stop receipts without this persisted set do not adopt an
        # arbitrary present-day operation. Keep their historical proof only.
        for identity in receipt.get("quiesces", []):
            prior_path = self.operations / f"{safe_id(identity)}.json"
            prior = self.read_receipt(prior_path)
            if prior["status"] in ("pending", "needs_reconcile"):
                prior["status"] = "quiesced_outcome_unknown"
                prior["quiesced_by"] = receipt["operation_id"]
                lab_module.atomic_json(prior_path, prior)

    def inspect(self, path, receipt):
        method = receipt["payload"]["method"]
        info = self.lab.unit_info(self.vm)
        if method == "start" and info.get("ActiveState") == "active":
            uuid = self.lab.qmp(self.vm, "query-uuid")
            if uuid.get("UUID") != self.vm["uuid"]:
                raise RuntimeError("live VM UUID does not match dedicated identity")
            self.lab.check_caps(self.vm)
            self.lab.ready(self.vm)
            receipt["status"] = "applied"
            receipt["external_proof"] = {"uuid": uuid["UUID"], "unit": self.vm["unit"], "running": True}
        elif method == "stop" and self.lab.stopped(self.vm):
            receipt["status"] = "applied"
            receipt["external_proof"] = {"unit": self.vm["unit"], "main_pid_zero": True, "cgroup_and_ports_quiet": True}
        else:
            receipt["status"] = "needs_reconcile"
        lab_module.atomic_json(path, receipt)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["promote", "status", "start", "stop"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--operation-id")
    args = parser.parse_args()
    lab = lab_module.Lab(args.root)
    dedicated = Dedicated(lab)
    if args.action == "promote":
        result = dedicated.promote()
    elif args.action == "status":
        result = dedicated.status()
    else:
        result = dedicated.operate(args.action, args.operation_id)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
