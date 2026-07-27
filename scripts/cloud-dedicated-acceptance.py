#!/usr/bin/env python3
"""Real dedicated VM persistence acceptance, no model credentials or tasks.

On the authorized V100 host only. Guest + native Host restarts exercise canary
persistence, NOT Agent/Goal recovery. Always finish with the guest stopped.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import time
import uuid

spec = importlib.util.spec_from_file_location("dedicated", Path(__file__).with_name("cloud-dedicated-vm.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",required=True)
    args=parser.parse_args()
    lab=module.lab_module.Lab(args.root)
    item=module.Dedicated(lab)
    prefix="acceptance-"+uuid.uuid4().hex[:16]
    records=[]
    output=lab.root / "dedicated" / f"{prefix}-report.json"
    def check(name, function):
        begin=time.monotonic()
        try:
            data=function()
            records.append({"name":name,"status":"passed","seconds":round(time.monotonic()-begin,3),"details":data})
            print("PASS "+name,flush=True)
            return data
        except Exception:
            records.append({"name":name,"status":"failed","seconds":round(time.monotonic()-begin,3)})
            raise
        finally:
            module.lab_module.atomic_json(output,{"schema":"xharness-dedicated-acceptance/v1","checks":records,"no_model_calls":True,"no_task_recovery_claim":True})
    def promote():
        one=item.promote(); two=item.promote()
        if one != two: raise RuntimeError("promotion changed fixed identity")
        return {"instance_id":one["instance_id"],"volume_id":one["volume_id"],"epoch":one["execution_epoch"]}
    def start():
        one=item.operate("start",prefix+"-start1"); two=item.operate("start",prefix+"-start1")
        if one != two or one["status"]!="applied": raise RuntimeError("start receipt is not idempotent")
        policy=module.lab_module.run(["systemctl","--user","show",item.vm["unit"],"--property=RuntimeMaxUSec","--value"]).strip()
        if policy != "infinity": raise RuntimeError("dedicated runtime still has an experiment expiry")
        return {"runtime_max":"infinity","resources":lab.check_caps(item.vm)}
    def routes():
        return lab.routes([item.vm])
    token=hashlib.sha256(prefix.encode()).hexdigest()
    path=f"/home/agent/workspace/.dedicated-{prefix}.txt"
    def write():
        lab.ssh(item.vm,f"test ! -e '{path}' && umask 077 && cat > '{path}'",input=token.encode())
        return {"sha256":hashlib.sha256(token.encode()).hexdigest()}
    def read():
        if lab.ssh(item.vm,f"cat '{path}'").strip()!=token: raise RuntimeError("guest data changed after disconnect/restart")
        return {"persisted":True}
    def native_restart():
        boot=lab.ssh(item.vm,"cat /proc/sys/kernel/random/boot_id").strip()
        lab.ssh(item.vm,"sudo systemctl restart xharness-lab-host.service")
        lab.ready(item.vm); routes(); read()
        if lab.ssh(item.vm,"cat /proc/sys/kernel/random/boot_id").strip()!=boot: raise RuntimeError("Host restart unexpectedly rebooted VM")
        return {"host_restarted":True,"data_and_canary_retained":True,"agent_tasks_tested":False}
    def guest_reboot():
        before=lab.ssh(item.vm,"cat /proc/sys/kernel/random/boot_id").strip()
        qemu=lab.check_caps(item.vm)["qemu_pid"]
        try: lab.ssh(item.vm,"sudo systemctl reboot",timeout=10)
        except Exception: pass  # Reboot closes SSH; query evidence instead.
        def changed():
            try: return lab.ssh(item.vm,"cat /proc/sys/kernel/random/boot_id",timeout=5).strip()!=before
            except Exception: return False
        lab.wait(changed,120); lab.ready(item.vm); routes(); read()
        if lab.check_caps(item.vm)["qemu_pid"]!=qemu: raise RuntimeError("guest reboot replaced QEMU identity")
        return {"guest_boot_id_changed":True,"same_qemu_process":True,"data_retained":True,"agent_tasks_tested":False}
    def stop_restart():
        stopped=item.operate("stop",prefix+"-stop1")
        if stopped["status"]!="applied" or not lab.stopped(item.vm): raise RuntimeError("external stop proof missing")
        item.operate("start",prefix+"-start2"); read(); routes()
        if item.environment["instance_id"]!=item.vm["uuid"]: raise RuntimeError("identity changed after cold VM start")
        return {"disk_and_identity_retained":True}
    def final_stop():
        receipt=item.operate("stop",prefix+"-final-stop")
        if receipt["status"]!="applied" or not all(lab.stopped(vm) for vm in lab.manifest["vms"]): raise RuntimeError("remaining live VM")
        return {"all_four_stopped":True,"disk_retained":True}
    try:
        check("promotion reuses original VM and volume",promote)
        check("persistent lifetime and duplicate start receipt",start)
        check("original Host routes only to dedicated VM",routes)
        check("workspace write within existing guest",write)
        check("new SSH connection observes retained data",read)
        check("native Host restart retains session and workspace",native_restart)
        check("guest reboot retains UUID disk and session",guest_reboot)
        check("external stop and cold start retain environment",stop_restart)
        check("external final stop keeps disk and clears all four VMs",final_stop)
    finally:
        lab.stop(item.vm)
    print(json.dumps({"report":str(output),"checks":len(records),"all_passed":all(r["status"]=="passed" for r in records)},indent=2))

if __name__=="__main__": main()
