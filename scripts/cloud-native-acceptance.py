#!/usr/bin/env python3
"""Original Host native permit acceptance inside retained VM-1, no model calls.

Use only with the existing authorized V100 lab. Never replace its original
Host/service, inject credentials, open public ports, create VMs or remove disks.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import subprocess
import time
import uuid

spec=importlib.util.spec_from_file_location("dedicated",Path(__file__).with_name("cloud-dedicated-vm.py"))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def digest(path):
    value=hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda:f.read(1024*1024),b""):value.update(block)
    return value.hexdigest()


def counter(value):
    # Cloud DTO counters are canonical decimal STRINGS, never JSON floats.
    if not isinstance(value,str) or not value or not value.isascii() or not value.isdecimal() or (len(value)>1 and value[0]=="0") or int(value)>2**64-1:
        raise RuntimeError("invalid native counter")
    return int(value)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",required=True)
    parser.add_argument("--host-binary",required=True)
    parser.add_argument("--permit-binary",required=True)
    args=parser.parse_args()
    lab=module.lab_module.Lab(args.root)
    item=module.Dedicated(lab)
    item.promote()
    vm=item.vm
    if not all(lab.stopped(v) for v in lab.manifest["vms"]):
        raise RuntimeError("all original lab VMs must be stopped before acceptance")
    binaries=[Path(args.host_binary).resolve(strict=True),Path(args.permit_binary).resolve(strict=True)]
    if any(not p.is_file() or p.stat().st_size>1024*1024*1024 for p in binaries):
        raise RuntimeError("invalid bounded native artifact")
    host_sha=digest(binaries[0])
    nonce="native-"+uuid.uuid4().hex[:16]
    root="/home/agent/cloud-native/"+nonce
    unit="xh-cloud-"+nonce+".service"
    permit=root+"/permit"
    quote=shlex.quote
    rows=[]
    output=lab.root/"dedicated"/(nonce+"-report.json")
    original_sha=None
    def save():
        module.lab_module.atomic_json(output,{"schema":"xharness-cloud-native-acceptance/v1","checks":rows,"vm_instance":vm["uuid"],"host_sha256":host_sha,"native_gate_only":True,"no_model_calls":True,"no_goal_bootstrap_claim":True})
    def check(name,fn):
        begin=time.monotonic()
        try:
            result=fn()
            rows.append({"name":name,"status":"passed","seconds":round(time.monotonic()-begin,3),"details":result})
            print("PASS "+name,flush=True)
            return result
        except Exception:
            rows.append({"name":name,"status":"failed","seconds":round(time.monotonic()-begin,3)})
            raise
        finally: save()
    def admin(action,payload=None):
        data=lab.ssh(vm,quote(root+"/xharness-native-permit")+" --journal-dir "+quote(permit)+" "+action,input=None if payload is None else json.dumps(payload).encode(),timeout=20)
        return json.loads(data)
    def transition(op,to):
        snapshot=admin("get")
        return {"operation_id":nonce+"-"+op,"scope":snapshot["permit"]["scope"],"expected_revision":snapshot["permit"]["revision"],"to":to}
    def unit_info():
        data=lab.ssh(vm,"sudo systemctl show "+quote(unit)+" --property=ActiveState,SubState,MainPID,ExecStart,MemoryPeak --no-pager",timeout=10,check=False)
        return dict(row.split("=",1) for row in data.splitlines() if "=" in row)
    def ensure_owned(info):
        if root+"/xharness-host" not in info.get("ExecStart",""):
            raise RuntimeError("acceptance unit identity mismatch")
    def start_native():
        existing=unit_info()
        if existing.get("ActiveState") in ("active","activating","deactivating"):
            raise RuntimeError("duplicate native launch refused")
        lab.ssh(vm,"sudo systemctl reset-failed "+quote(unit),check=False)
        command=["sudo","systemd-run","--quiet","--collect","--unit="+unit,"--uid=agent","--property=MemoryMax=1G","--property=MemorySwapMax=0","--property=TasksMax=128","--property=KillMode=control-group","--property=TimeoutStopSec=25s","--setenv=TOKIO_WORKER_THREADS=2","--setenv=HOME=/home/agent",root+"/xharness-host","--bind","127.0.0.1:3082","--workspace",root+"/workspace","--state-dir",root+"/state","--hosted-permit-dir",permit,"--model","unconfigured"]
        lab.ssh(vm,shlex.join(command),timeout=15)
    def stop_native():
        info=unit_info()
        if info.get("ActiveState") in ("active","activating","deactivating"):
            ensure_owned(info)
            lab.ssh(vm,"sudo systemctl stop "+quote(unit),timeout=40)
    def ready(generation):
        def observed():
            try:
                receipt=admin("launch "+str(generation))
                if receipt["phase"]!="ready": return False
                lab.ssh(vm,"curl --noproxy '*' --fail --silent --max-time 2 http://127.0.0.1:3082/health/ready >/dev/null",timeout=5)
                return True
            except Exception:return False
        lab.wait(observed,150)
        ensure_owned(unit_info())
        return admin("launch "+str(generation))
    def stopped(generation,sealed):
        def observed():
            try:return admin("launch "+str(generation))["phase"]=="stopped"
            except Exception:return False
        lab.wait(observed,40)
        receipt=admin("launch "+str(generation))
        expected={"sealed":sealed,"runtime_graceful":True,"forced_workers":0,"cleanup_errors":0}
        if receipt["shutdown"]!=expected:raise RuntimeError("native cleanup was not proven graceful")
        return receipt
    def start_vm():
        item.operate("start",nonce+"-start")
        lab.ready(vm)
        return {"resources":lab.check_caps(vm),"same_instance":item.environment["instance_id"]==vm["uuid"]}
    def prepare():
        nonlocal original_sha
        original_sha=lab.ssh(vm,"sha256sum /home/agent/xharness-host").split()[0]
        lab.ssh(vm,"umask 077 && test ! -L /home/agent/cloud-native && mkdir -p /home/agent/cloud-native && test ! -e "+quote(root)+" && mkdir "+quote(root)+" && test \"$(realpath "+quote(root)+")\" = "+quote(root)+" && mkdir "+quote(root+"/workspace")+" "+quote(root+"/state"))
        for source,name in zip(binaries,["xharness-host","xharness-native-permit"]):
            with source.open("rb") as stream:
                result=subprocess.run(lab.ssh_command(vm,"umask 077 && cat > "+quote(root+"/"+name)+" && chmod 700 "+quote(root+"/"+name)),stdin=stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=240)
            if result.returncode:raise RuntimeError("native fixture upload failed")
        if lab.ssh(vm,"sha256sum "+quote(root+"/xharness-host")).split()[0]!=host_sha:
            raise RuntimeError("native fixture build digest changed in transit")
        binding={"scope":{"task_id":nonce,"binding_id":nonce+"-binding","environment_instance_id":vm["uuid"],"volume_id":item.environment["volume_id"],"execution_epoch":item.environment["execution_epoch"]},"root_session_id":nonce+"-root","host_build_ref":{"id":"native-acceptance-host","version":host_sha},"external_stop_authorized":True,"external_stop_support":"supported"}
        request={"binding":binding,"workspace":root+"/workspace","state_dir":root+"/state"}
        snapshot=admin("initialize",request)
        if snapshot!=admin("initialize",request) or snapshot["permit"]["permit"]!="prepared":raise RuntimeError("native prepare replay mismatch")
        return {"host_digest_verified":True,"original_host_unchanged":True}
    def dormant():
        start_native();time.sleep(3)
        info=unit_info();ensure_owned(info)
        if info["ActiveState"]!="active" or counter(admin("get")["launch_generation"])!=0:raise RuntimeError("Prepared launched work")
        lab.ssh(vm,"test ! -d "+quote(root+"/state/sessions")+" && test ! -d "+quote(root+"/state/control")+" && ! curl --noproxy '*' --fail --silent --max-time 2 http://127.0.0.1:3082/health/ready >/dev/null",timeout=5)
        return {"no_original_runtime_or_ready":True}
    def activate():
        command=transition("activate","active");one=admin("transition",command)
        if one!=admin("transition",command):raise RuntimeError("activate acknowledgement changed")
        ready(1)
        return {"generation":1,"original_host_ready":True}
    def restart():
        stop_native();stopped(1,False)
        if admin("get")["permit"]["permit"]!="active":raise RuntimeError("temporary stop changed authority")
        start_native();ready(2)
        return {"generation":2,"unsealed_resume":True}
    def seal():
        command=transition("seal","sealed");one=admin("transition",command)
        if one!=admin("transition",command):raise RuntimeError("seal acknowledgement changed")
        stopped(2,True)
        lab.wait(lambda:unit_info().get("ActiveState") not in ("active","activating","deactivating"),25)
        return {"runtime_stopped":True,"sealed":True}
    def prevent_restart():
        start_native()
        lab.wait(lambda:unit_info().get("ActiveState") not in ("active","activating","deactivating"),150)
        if counter(admin("get")["launch_generation"])!=2:raise RuntimeError("sealed task was revived")
        if lab.ssh(vm,"sha256sum /home/agent/xharness-host").split()[0]!=original_sha:raise RuntimeError("original lab Host was replaced")
        lab.routes([vm])
        return {"no_new_generation":True,"original_lab_service_retained":True}
    def final_stop():
        stop_native();item.operate("stop",nonce+"-stop")
        if not all(lab.stopped(v) for v in lab.manifest["vms"]):raise RuntimeError("remaining live VM")
        return {"all_four_vms_stopped":True,"disk_retained":True}
    try:
        check("reuse original dedicated VM and hard caps",start_vm)
        check("deploy separate pinned native fixture and replay prepare",prepare)
        check("Prepared cannot restore Runtime or serve Ready",dormant)
        check("Activate ack replay and original Host Ready",activate)
        check("graceful temporary native stop and generation resume",restart)
        check("seal produces original Runtime cleanup receipt",seal)
        check("sealed restart cannot revive task or overwrite original Host",prevent_restart)
        check("external VM quiet proof and retained disk",final_stop)
    finally:
        try:
            if not lab.stopped(vm):stop_native()
        finally:lab.stop(vm)
        save()
    print(json.dumps({"report":str(output),"checks":len(rows),"all_passed":all(r["status"]=="passed" for r in rows)},indent=2))


if __name__=="__main__":main()
