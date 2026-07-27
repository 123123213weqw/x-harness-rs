#!/usr/bin/env python3
"""Register a proven persistent lab VM with honest, incomplete capabilities.

No model/credential injection. Admission must remain unavailable until the
native Host recovery/stop adapter proves the remaining required capabilities.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import time

spec=importlib.util.spec_from_file_location("dedicated",Path(__file__).with_name("cloud-dedicated-vm.py"))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",required=True)
    parser.add_argument("--control-dir",required=True)
    parser.add_argument("--binary",required=True)
    args=parser.parse_args()
    lab=module.lab_module.Lab(args.root)
    item=module.Dedicated(lab)
    if not item.environment or not lab.stopped(item.vm):
        raise RuntimeError("register only an existing, verified-stopped dedicated VM")
    reports=[]
    for path in item.root.glob("acceptance-*-report.json"):
        record=json.loads(path.read_text())
        if len(record.get("checks",[]))==9 and all(c["status"]=="passed" for c in record["checks"]):
            reports.append(path)
    if not reports: raise RuntimeError("dedicated real acceptance proof is required")
    reference=lambda name:{"id":name,"version":"v1"}
    env_path=item.root / "control-registration-v1.json"
    if env_path.exists():
        environment=json.loads(env_path.read_text())
        if environment["instance_id"]!=item.vm["uuid"] or environment["volume_id"]!=item.environment["volume_id"]:
            raise RuntimeError("existing registration has another identity")
    else:
        observed=str(int(time.time()*1000))
        support={"dedicated_linux":"supported","persistent_volume":"supported","external_stop":"supported",
                 "deployment":"supported","memory_hard_limit":"supported",
                 "cpu_hard_limit":"unsupported","disk_hard_limit":"unsupported",
                 "single_writer":"unknown","full_access":"unknown","managed_cleanup":"unknown",
                 "model_reachable":"unknown","material_reachable":"unknown","retention":"unknown","sudo":"unknown"}
        capabilities={key:{"support":value,"observed_at_ms":observed,
            "constraints":["dedicated infrastructure acceptance only; native task bootstrap, execution fencing and retention are not yet connected"]}
            for key,value in support.items()}
        environment={"owner_id":"owner-wangyue","environment_ref":reference("v100-dedicated-1"),
                     "instance_id":item.vm["uuid"],"volume_id":item.environment["volume_id"],
                     "host_build_ref":{"id":"host-build","version":lab.manifest["host_sha256"]},
                     "execution_epoch":"1","capabilities":capabilities,
                     "resource_policy_ref":reference("v100-dedicated-resources"),
                     "stop_policy_ref":reference("v100-dedicated-stop"),
                     "retention_policy_ref":reference("v100-dedicated-retention"),
                     "required_resource_capabilities":["memory_hard_limit"],"external_stop_authorized":True}
        module.lab_module.atomic_json(env_path,environment)
    binary=Path(args.binary).resolve(strict=True)
    control=Path(args.control_dir).expanduser().absolute()
    prefix=[str(binary),"--state-dir",str(control)]
    def command(tail,body=None):
        result=subprocess.run(prefix+tail,input=body,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
        if result.returncode: raise RuntimeError("trusted cloud control CLI rejected operation")
        return json.loads(result.stdout)
    command(["register"],json.dumps(environment).encode())
    command(["register"],json.dumps(environment).encode())  # reopen/replay
    environments=command(["environments","owner-wangyue"])
    tasks=command(["list","owner-wangyue"])
    if len(environments)!=1 or environments[0]!=environment or tasks:
        raise RuntimeError("control restart changed binding metadata or admitted unexpected work")
    denial={"protocol":"xharness-cloud/v1","request_id":"readiness-gate-canary","method":"task.submit","payload":{"spec":{
        "environment_ref":environment["environment_ref"],"objective":"Only a readiness gate canary; do not run.",
        "acceptance_criteria":["unverified native capabilities must reject before task admission"],
        "workspace_source":{"kind":"existing_workspace","workspace_ref":reference("vm-workspace"),"expected_fingerprint":"0"*64},
        "selected_material_refs":[],"model_config_ref":reference("not-configured"),"credential_ref":reference("not-injected"),
        "permission":"full-access","system_privilege":"standard-user",
        "resource_policy_ref":environment["resource_policy_ref"],"stop_policy_ref":environment["stop_policy_ref"],
        "usage_policy_ref":None,"retention_policy_ref":environment["retention_policy_ref"],"notification_policy_ref":None}}}
    result=subprocess.run(prefix+["admit","owner-wangyue"],input=json.dumps(denial).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
    if result.returncode==0 or b"CapabilityUnavailable" not in result.stderr or command(["list","owner-wangyue"]):
        raise RuntimeError("unverified VM became runnable through persistent registration")
    proof={"schema":"xharness-dedicated-control-registration/v1","environment":environment["environment_ref"],
           "registered_and_reopened":True,"unverified_task_rejected_before_effects":True,"tasks_admitted":0,"credentials_injected":False}
    module.lab_module.atomic_json(item.root / "control-registration-report.json",proof)
    print(json.dumps(proof,indent=2))

if __name__=="__main__":main()
