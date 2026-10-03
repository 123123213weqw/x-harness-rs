#!/usr/bin/env python3
"""Opt-in four-VM acceptance lab. Not a production cloud controller.

Run on the authorized Linux test host, never on the local Mac. No GPU,
host workspace mounts, public listeners, password auth, or forwarded agents.
The image must already be downloaded and verified against Canonical SHA256SUMS.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid


SCHEMA = "xharness-four-vm-lab/v1"
SESSION = "cloud-lab-routing-canary"
GUEST_RAM_MIB = 2048
HOST_MEMORY_MAX = 4 * 1024**3
DISK_GIB = 16


def run(argv, *, input=None, timeout=60, check=True):
    result = subprocess.run(argv, input=input, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        # Never include stdin (cloud-init host private keys, binary, etc.).
        raise RuntimeError(f"{Path(argv[0]).name} exited {result.returncode}: "
                           + result.stderr.decode(errors="replace")[-2000:])
    return result.stdout.decode(errors="replace")


def atomic_json(path, value):
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    with temporary.open("x", encoding="utf8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def qmp(path, command):
    """Read complete JSON lines, ignore asynchronous events, bound frame size."""
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(5)
        client.connect(str(path))
        with client.makefile("rwb") as stream:
            def read():
                line = stream.readline(1024 * 1024 + 1)
                if not line or len(line) > 1024 * 1024:
                    raise RuntimeError("incomplete or oversized QMP frame")
                return json.loads(line)
            if "QMP" not in read():
                raise RuntimeError("invalid QMP greeting")
            for sequence, action in enumerate(["qmp_capabilities", command]):
                stream.write((json.dumps({"execute": action, "id": sequence})
                              + "\n").encode())
                stream.flush()
                while True:
                    frame = read()
                    if frame.get("id") != sequence:
                        continue
                    if "error" in frame:
                        raise RuntimeError(f"QMP rejected {action}: {frame['error']}")
                    if "return" not in frame:
                        raise RuntimeError("QMP result has no return value")
                    result = frame["return"]
                    break
            return result


def free_ports(ports):
    with contextlib.ExitStack() as stack:
        for port in ports:
            sock = stack.enter_context(socket.socket())
            # A stopped listener may leave TCP TIME_WAIT. This is not a live
            # VM. Reuse that state, but never SO_REUSEPORT or a new endpoint.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))
            sock.listen(1)  # Still rejects another active listener.


def allowed_cpus():
    return sorted(os.sched_getaffinity(0))


class Lab:
    def __init__(self, root):
        if sys.platform != "linux" or os.getuid() == 0:
            raise RuntimeError("lab requires an unprivileged Linux user")
        root = Path(root).expanduser().absolute()
        if root.is_symlink():
            raise RuntimeError("lab root cannot be a symlink")
        # WZU's home itself is an administrator-managed symlink. Canonicalize
        # that known parent, but never accept a caller-selected sibling root.
        parent = (Path.home() / "codex-build/x-harness-rs").resolve()
        if root.parent.resolve() != parent:
            raise RuntimeError("lab root must be a direct child of ~/codex-build/x-harness-rs")
        root = root.resolve()
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if root.stat().st_uid != os.getuid():
            raise RuntimeError("lab root is not owned by current user")
        root.chmod(0o700)
        self.root = root
        self.manifest = None
        self.evidence = []
        self.lock = (root / ".writer.lock").open("a")
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (root / "lab.json").exists():
            self.manifest = json.loads((root / "lab.json").read_text())
            self.validate_manifest()

    def validate_manifest(self):
        m = self.manifest
        if m["schema"] != SCHEMA or m["root"] != str(self.root):
            raise RuntimeError("lab manifest schema/root mismatch")
        uuid.UUID(m["lab_id"])
        if len(m["vms"]) != 4:
            raise RuntimeError("lab must have exactly four scoped VMs")
        prefix = "xh-cloud-" + m["lab_id"].split("-")[0]
        ports = []
        for index, vm in enumerate(m["vms"], 1):
            if vm["name"] != f"vm-{index}" or vm["unit"] != f"{prefix}-{index}.service":
                raise RuntimeError("invalid VM identity/unit scope")
            uuid.UUID(vm["uuid"])
            if len(vm["cpus"]) != 2 or not set(vm["cpus"]) <= set(allowed_cpus()):
                raise RuntimeError("invalid CPU affinity")
            ports += [vm["ssh_port"], vm["http_port"]]
        if len(set(ports)) != 8 or any(not 1024 <= p < 65536 for p in ports):
            raise RuntimeError("invalid loopback endpoints")

    def prepare(self, binary, port_base):
        if self.manifest is not None:
            raise RuntimeError("lab already prepared; use experiment/status/stop")
        binary = Path(binary).resolve(strict=True)
        image = self.root / "images/base.img"
        verification = json.loads((self.root / "images/verified.json").read_text())
        if digest(image) != verification["sha256"]:
            raise RuntimeError("cloud image fingerprint changed")
        info = json.loads(run(["qemu-img", "info", "--output=json", str(image)]))
        if info["format"] != "qcow2" or info.get("backing-filename"):
            raise RuntimeError("base must be a standalone qcow2 image")
        for path in [Path("/dev/kvm"), Path("/sys/fs/cgroup/cgroup.controllers")]:
            if not path.exists():
                raise RuntimeError(f"required capability missing: {path}")
        if not os.access("/dev/kvm", os.R_OK | os.W_OK):
            raise RuntimeError("KVM inaccessible")
        cpus = allowed_cpus()
        if len(cpus) < 16:
            raise RuntimeError("insufficient host CPU headroom")
        mem = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        if int(mem["MemAvailable"].split()[0]) < 32 * 1024**2:
            raise RuntimeError("less than 32 GiB available host memory")
        fs = os.statvfs(self.root)
        if fs.f_bavail * fs.f_frsize < 4 * DISK_GIB * 1024**3 + 8 * 1024**3:
            raise RuntimeError("insufficient disk space for worst-case VM growth")
        ports = [port_base + i for i in range(8)]
        free_ports(ports)
        lab_id = str(uuid.uuid4())
        prefix = "xh-cloud-" + lab_id.split("-")[0]
        auth = self.root / "auth"
        auth.mkdir(mode=0o700)
        run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(auth / "client")])
        client_public = (auth / "client.pub").read_text().strip()
        known_hosts = []
        vms = []
        for index in range(1, 5):
            directory = self.root / f"vm-{index}"
            directory.mkdir(mode=0o700)
            host_key = auth / f"guest-{index}"
            run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(host_key)])
            vm = {"name": f"vm-{index}", "uuid": str(uuid.uuid4()),
                  "unit": f"{prefix}-{index}.service", "ssh_port": ports[2*(index-1)],
                  "http_port": ports[2*(index-1)+1], "cpus": cpus[-8:][2*(index-1):2*index]}
            vms.append(vm)
            known_hosts.append(f"[127.0.0.1]:{vm['ssh_port']} "
                               + " ".join(host_key.with_suffix(".pub").read_text().split()[:2]))
            config = {"hostname": vm["name"], "manage_etc_hosts": True,
                      "ssh_pwauth": False, "disable_root": True,
                      "ssh_keys": {"ed25519_private": host_key.read_text(),
                                   "ed25519_public": host_key.with_suffix(".pub").read_text()},
                      "users": [{"name": "agent", "shell": "/bin/bash", "lock_passwd": True,
                                 "sudo": "ALL=(ALL) NOPASSWD:ALL", "ssh_authorized_keys": [client_public]}],
                      "package_update": False, "package_upgrade": False,
                      "runcmd": [["mkdir", "-p", "/home/agent/workspace", "/home/agent/state"],
                                  ["chown", "-R", "agent:agent", "/home/agent/workspace", "/home/agent/state"]]}
            (directory / "user-data").write_text("#cloud-config\n" + json.dumps(config))
            (directory / "user-data").chmod(0o600)
            (directory / "meta-data").write_text(f"instance-id: {vm['uuid']}\nlocal-hostname: {vm['name']}\n")
            run(["cloud-localds", str(directory / "seed.iso"), str(directory / "user-data"),
                 str(directory / "meta-data")])
            run(self.sandbox(vm) + ["/usr/bin/qemu-img", "create", "-f", "qcow2", "-F", "qcow2",
                                    "-b", "/base.img", "/work/disk.qcow2", f"{DISK_GIB}G"])
        (auth / "known_hosts").write_text("\n".join(known_hosts) + "\n")
        m = {"schema": SCHEMA, "root": str(self.root), "lab_id": lab_id,
             "image": verification, "host_binary": str(binary), "host_sha256": digest(binary),
             "guest_memory_mib": GUEST_RAM_MIB, "host_memory_max_bytes": HOST_MEMORY_MAX,
             "virtual_disk_gib": DISK_GIB, "network": "loopback forwards; guest egress denied",
             "vms": vms}
        atomic_json(self.root / "lab.json", m)
        self.manifest = m
        self.validate_manifest()

    def sandbox(self, vm):
        return ["bwrap", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
                "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
                "--proc", "/proc", "--dev", "/dev", "--dev-bind", "/dev/kvm", "/dev/kvm",
                "--tmpfs", "/tmp", "--bind", str(self.root / vm["name"]), "/work",
                "--ro-bind", str(self.root / "images/base.img"), "/base.img",
                "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
                "--new-session", "--die-with-parent", "--chdir", "/work", "--"]

    def unit_info(self, vm):
        fields = ["ActiveState", "SubState", "ControlGroup", "ExecStart", "MemoryCurrent",
                  "MemoryPeak", "Result", "MainPID"]
        output = run(["systemctl", "--user", "show", vm["unit"], "--no-pager"]
                     + [f"--property={f}" for f in fields])
        return dict(line.split("=", 1) for line in output.splitlines() if "=" in line)

    def qmp(self, vm, command):
        info = self.unit_info(vm)
        if str(self.root / vm["name"]) not in info.get("ExecStart", ""):
            raise RuntimeError("VM unit is not owned by this lab")
        return qmp(self.root / vm["name"] / "qmp.sock", command)

    def start(self, vm, *, runtime_max_seconds=1800):
        if not isinstance(runtime_max_seconds, int) or not 0 <= runtime_max_seconds <= 86400:
            raise RuntimeError("invalid VM runtime limit")
        if self.unit_info(vm).get("ActiveState") in ("active", "activating", "deactivating"):
            raise RuntimeError("VM already active/transitioning; refusing duplicate start")
        # Startup refuses occupied endpoints rather than selecting a different resource.
        free_ports([vm["ssh_port"], vm["http_port"]])
        sock = self.root / vm["name"] / "qmp.sock"
        sock.unlink(missing_ok=True)
        run(["systemctl", "--user", "reset-failed", vm["unit"]], check=False)
        network = (f"user,id=n0,restrict=on,hostfwd=tcp:127.0.0.1:{vm['ssh_port']}-:22,"
                   f"hostfwd=tcp:127.0.0.1:{vm['http_port']}-:3080")
        command = ["systemd-run", "--user", f"--unit={vm['unit']}",
                   "--property=MemoryMax=4G", "--property=MemorySwapMax=0",
                   "--property=TasksMax=128", f"--property=RuntimeMaxSec={runtime_max_seconds or 'infinity'}",
                   "--property=TimeoutStopSec=15", "--property=KillMode=control-group",
                   "--property=Restart=no", "--property=StandardOutput=null"]
        command += self.sandbox(vm)
        command += ["/usr/bin/taskset", "-c", ",".join(map(str, vm["cpus"])),
                    "/usr/bin/qemu-system-x86_64", "-machine", "q35,accel=kvm", "-cpu", "host",
                    "-smp", "2", "-m", str(GUEST_RAM_MIB), "-uuid", vm["uuid"],
                    "-nodefaults", "-no-user-config", "-display", "none",
                    "-serial", "file:/work/console.log",
                    "-drive", "file=/work/disk.qcow2,if=virtio,format=qcow2,cache=none",
                    "-drive", "file=/work/seed.iso,if=virtio,format=raw,readonly=on",
                    "-netdev", network, "-device", "virtio-net-pci,netdev=n0",
                    "-qmp", "unix:/work/qmp.sock,server=on,wait=off",
                    "-sandbox", "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny"]
        run(command)
        self.wait(lambda: sock.exists() or self.unit_info(vm).get("ActiveState") == "failed", 20)
        if self.unit_info(vm).get("ActiveState") != "active":
            raise RuntimeError("QEMU failed: " + run(["journalctl", "--user", "-u", vm["unit"],
                                                       "-n", "15", "--no-pager"]))
        self.check_caps(vm)

    def check_caps(self, vm):
        info = self.unit_info(vm)
        cg = Path("/sys/fs/cgroup" + info["ControlGroup"])
        if int((cg / "memory.max").read_text()) != HOST_MEMORY_MAX:
            raise RuntimeError("host memory hard cap did not take effect")
        if int((cg / "memory.swap.max").read_text()) != 0 or int((cg / "pids.max").read_text()) != 128:
            raise RuntimeError("host swap/process hard caps did not take effect")
        pids = (cg / "cgroup.procs").read_text().split()
        qemu = [int(pid) for pid in pids if Path(f"/proc/{pid}/comm").read_text().startswith("qemu-system")]
        if len(qemu) != 1 or set(os.sched_getaffinity(qemu[0])) != set(vm["cpus"]):
            raise RuntimeError("QEMU CPU affinity bound did not take effect")
        return {"memory_current": int((cg / "memory.current").read_text()),
                "memory_peak": int((cg / "memory.peak").read_text()),
                "memory_max": HOST_MEMORY_MAX, "cpus": vm["cpus"], "qemu_pid": qemu[0]}

    def ssh_command(self, vm, command):
        auth = self.root / "auth"
        return ["ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                "-o", f"UserKnownHostsFile={auth / 'known_hosts'}", "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "HostKeyAlgorithms=ssh-ed25519", "-o", "IdentitiesOnly=yes",
                "-o", "IdentityAgent=none", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=3",
                "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
                "-i", str(auth / "client"), "-p", str(vm["ssh_port"]), "agent@127.0.0.1", command]

    def ssh(self, vm, command, **kw):
        return run(self.ssh_command(vm, command), **kw)

    @staticmethod
    def wait(predicate, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                if predicate():
                    return
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                pass
            time.sleep(1)
        raise RuntimeError(f"readiness/condition timeout after {seconds}s")

    def guest_ready(self, vm):
        self.wait(lambda: self.ssh(vm, "test -d /home/agent/workspace && printf ready", timeout=8) == "ready", 240)
        # Explicitly wait for cloud-init, not merely SSH availability.
        self.ssh(vm, "sudo cloud-init status --wait", timeout=120)

    def deploy(self, vm):
        binary = Path(self.manifest["host_binary"])
        if digest(binary) != self.manifest["host_sha256"]:
            raise RuntimeError("fixed Host binary changed")
        with binary.open("rb") as stream:
            result = subprocess.run(self.ssh_command(vm, "cat > /home/agent/xharness-host.tmp && "
                                      "chmod 700 /home/agent/xharness-host.tmp && "
                                      "mv /home/agent/xharness-host.tmp /home/agent/xharness-host"),
                                    stdin=stream, capture_output=True, timeout=180)
            if result.returncode:
                raise RuntimeError("Host binary transfer failed")
        received = self.ssh(vm, "sha256sum /home/agent/xharness-host").split()[0]
        if received != self.manifest["host_sha256"]:
            raise RuntimeError("Host deployment hash mismatch")
        service = """[Unit]
Description=XHarness disposable cloud VM lab Host (no model credentials)
After=network.target
[Service]
User=agent
WorkingDirectory=/home/agent/workspace
ExecStart=/home/agent/xharness-host --bind 0.0.0.0:3080 --workspace /home/agent/workspace --state-dir /home/agent/state --debug-trace off
Restart=no
KillMode=control-group
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
"""
        self.ssh(vm, "sudo tee /etc/systemd/system/xharness-lab-host.service >/dev/null && "
                 "sudo systemctl daemon-reload && sudo systemctl enable --now xharness-lab-host.service",
                 input=service.encode())
        self.ready(vm)

    def rpc(self, vm, method, payload=None):
        body = json.dumps({"type": "client-request", "rpcId": str(uuid.uuid4()),
                           "method": method, "payload": payload or {}}).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{vm['http_port']}/api/{method}", body,
                                         {"Content-Type": "application/json"})
        # Never route acceptance RPC through HTTP_PROXY / environment proxies.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=8) as response:
            result = json.load(response)
        if not result["result"]["ok"]:
            raise RuntimeError(f"native RPC rejected {method}: {result['result']}")
        return result["result"]["value"]

    def ready(self, vm):
        self.wait(lambda: isinstance(self.rpc(vm, "session.list")["items"], list), 120)

    def stopped(self, vm):
        info = self.unit_info(vm)
        if info.get("ActiveState") not in ("inactive", "failed") or int(info.get("MainPID", "0")) != 0:
            return False
        cg_name = info.get("ControlGroup", "")
        if cg_name:
            procs = Path("/sys/fs/cgroup" + cg_name) / "cgroup.procs"
            if procs.exists() and procs.read_text().strip():
                return False
        # Closed HTTP does NOT by itself prove stopped. It supplements external unit proof.
        for port in (vm["http_port"], vm["ssh_port"]):
            with socket.socket() as sock:
                sock.settimeout(.3)
                if sock.connect_ex(("127.0.0.1", port)) == 0:
                    return False
        return True

    def stop(self, vm):
        info = self.unit_info(vm)
        if info.get("ActiveState") in ("active", "activating", "deactivating"):
            if str(self.root / vm["name"]) not in info.get("ExecStart", ""):
                raise RuntimeError("refusing to stop a unit not owned by this lab")
            run(["systemctl", "--user", "stop", vm["unit"]], timeout=30)
        self.wait(lambda: self.stopped(vm), 30)

    def check(self, name, function):
        start = time.monotonic()
        try:
            value = function()
            self.evidence.append({"name": name, "status": "passed", "seconds": round(time.monotonic()-start, 3),
                                  "details": value})
            print(f"PASS {name}", flush=True)
            return value
        except Exception as error:
            self.evidence.append({"name": name, "status": "failed", "seconds": round(time.monotonic()-start, 3),
                                  "error": str(error)})
            raise
        finally:
            atomic_json(self.root / "checks.json", self.evidence)

    def routes(self, vms):
        results = []
        for vm in vms:
            items = self.rpc(vm, "session.list")["items"]
            match = [item for item in items if item["sessionId"] == SESSION]
            if len(match) != 1 or match[0]["projections"]["values"].get("title") != vm["name"]:
                raise RuntimeError("connection switch returned another environment's session")
            results.append(vm["name"])
        return results

    def experiment(self, rerun=False):
        if self.manifest is None:
            raise RuntimeError("prepare the lab first")
        vms = self.manifest["vms"]
        previous = self.root / "report.json"
        if previous.exists():
            if not rerun or not all(self.stopped(v) for v in vms):
                raise RuntimeError("existing report requires --rerun and external stopped proof for all VMs")
            suffix = str(time.time_ns())
            # Keep failed evidence. A retry never erases the failure or disks.
            os.rename(previous, self.root / f"report-attempt-{suffix}.json")
            if (self.root / "checks.json").exists():
                os.rename(self.root / "checks.json", self.root / f"checks-attempt-{suffix}.json")
        report = {"schema": SCHEMA, "lab_id": self.manifest["lab_id"],
                  "scope": "real KVM + original Host APIs; NOT cloud task migration, Goal or live model acceptance",
                  "started_at_unix_ms": int(time.time()*1000), "status": "running"}
        atomic_json(self.root / "report.json", report)
        failed = None
        sampling_done = threading.Event()
        samples = []
        sampler = None
        try:
            for vm in vms:
                self.start(vm)
            cgroups = [Path("/sys/fs/cgroup" + self.unit_info(v)["ControlGroup"]) for v in vms]
            def sample():
                while not sampling_done.is_set():
                    values = []
                    for cg in cgroups:
                        try:
                            values.append(int((cg / "memory.current").read_text()))
                        except FileNotFoundError:
                            values.append(0)
                        except OSError:
                            values.append(None)
                    samples.append({"elapsed_ms": int(time.monotonic()*1000), "bytes": values})
                    sampling_done.wait(.5)
            sampler = threading.Thread(target=sample, daemon=True)
            sampler.start()
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(self.guest_ready, vms))
            identities = [self.ssh(v, "cat /etc/machine-id; hostname; cat /proc/sys/kernel/random/boot_id").splitlines()
                          for v in vms]
            self.check("four_independent_real_guests", lambda: require(len({x[0] for x in identities}) == 4,
                                                                       identities))
            self.check("host_hard_caps_and_cpu_affinity", lambda: [self.check_caps(v) for v in vms])
            self.check("guest_network_egress_denied", lambda: [self.ssh(v, "python3 -c " + shlex.quote(
                "import socket; s=socket.socket(); s.settimeout(2); "
                "assert s.connect_ex(('10.0.2.2',22))!=0; s.close(); "
                "s=socket.socket(); s.settimeout(2); assert s.connect_ex(('1.1.1.1',443))!=0; print('denied')"))
                for v in vms])
            for vm in vms:
                self.deploy(vm)
                items = self.rpc(vm, "session.list")["items"]
                if not any(item["sessionId"] == SESSION for item in items):
                    self.rpc(vm, "session.create", {"sessionId": SESSION, "cwd": "/home/agent/workspace"})
                self.rpc(vm, "session.rename", {"sessionId": SESSION, "title": vm["name"]})
                self.ssh(vm, "printf " + shlex.quote(vm["name"]) + " > /home/agent/workspace/canary")
            self.check("real_host_ready_in_all_four_guests", lambda: self.routes(vms))
            self.check("sixteen_connection_switches_no_cross_vm_history", lambda: self.routes(vms * 4))
            self.check("independent_workspace_disks", lambda: require(
                [self.ssh(v, "cat /home/agent/workspace/canary") for v in vms] == [v["name"] for v in vms]))
            self.check("duplicate_vm_start_is_refused", lambda: expect_error(lambda: self.start(vms[0])))
            before = self.rpc(vms[0], "session.history", {"sessionId": SESSION})
            self.ssh(vms[0], "sudo systemctl restart xharness-lab-host.service", timeout=60)
            self.ready(vms[0])
            self.check("native_host_restart_preserves_session_without_recreate", lambda: require(
                self.rpc(vms[0], "session.history", {"sessionId": SESSION})["events"] == before["events"],
                self.routes([vms[0]])))
            self.qmp(vms[2], "stop")
            paused = self.qmp(vms[2], "query-status")
            self.check("paused_guest_is_not_a_stop_proof", lambda: require(
                paused["status"] == "paused" and not self.stopped(vms[2]), paused))
            self.check("unrelated_hosts_usable_while_one_guest_is_paused", lambda: self.routes([vms[0], vms[1], vms[3]]))
            self.qmp(vms[2], "cont")
            self.ready(vms[2])
            self.check("paused_guest_recovers_same_session", lambda: self.routes([vms[2]]))
            # A guest-only workload: validates disconnect/lifecycle, not an Agent or Goal.
            heartbeat = "import time; from pathlib import Path; p=Path('/home/agent/workspace/heartbeat'); " \
                        "\nfor i in range(60):\n p.write_text(str(i)); time.sleep(.2)\n"
            self.ssh(vms[3], "cat > /home/agent/heartbeat.py", input=heartbeat.encode())
            self.ssh(vms[3], "sudo systemd-run --unit=xharness-lab-heartbeat --property=User=agent "
                     "/usr/bin/python3 /home/agent/heartbeat.py")
            self.wait(lambda: self.ssh(vms[3], "test -s /home/agent/workspace/heartbeat && echo yes") == "yes\n", 10)
            initial = int(self.ssh(vms[3], "cat /home/agent/workspace/heartbeat"))
            time.sleep(2)  # No observation connection held during this interval.
            later = int(self.ssh(vms[3], "cat /home/agent/workspace/heartbeat"))
            self.check("client_disconnect_does_not_stop_guest_workload", lambda: require(later > initial,
                                                                                       {"before": initial, "after": later}))
            self.ssh(vms[3], "sudo systemctl stop xharness-lab-heartbeat.service")
            # Kill only the exact lab unit. Drop its acknowledgement and reconcile externally.
            run(["systemctl", "--user", "kill", "--kill-who=all", "--signal=SIGKILL", vms[1]["unit"]])
            self.wait(lambda: self.stopped(vms[1]), 30)
            self.check("lost_stop_ack_is_reconciled_from_external_stop_proof", lambda: require(self.stopped(vms[1])))
            self.check("single_vm_crash_does_not_stop_other_hosts", lambda: self.routes([vms[0], vms[2], vms[3]]))
            self.start(vms[1])
            self.guest_ready(vms[1])
            self.ready(vms[1])
            self.check("vm_crash_restart_keeps_disk_and_native_history", lambda: require(
                self.ssh(vms[1], "cat /home/agent/workspace/canary") == vms[1]["name"], self.routes([vms[1]])))
            self.check("parallel_connections_after_recovery", lambda: self.parallel_routes(vms))
            report["resources_before_stop"] = [self.check_caps(v) for v in vms]
        except BaseException as error:
            failed = error
            report["error"] = str(error)
        finally:
            cleanup_errors = []
            for vm in vms:
                try:
                    self.stop(vm)
                except Exception as error:
                    cleanup_errors.append({"vm": vm["name"], "error": str(error)})
            report["cleanup_errors"] = cleanup_errors
            report["all_vms_verified_stopped"] = not cleanup_errors and all(self.stopped(v) for v in vms)
            sampling_done.set()
            if sampler is not None:
                sampler.join(3)
            report["resource_samples"] = samples
            complete_samples = [sum(s["bytes"]) for s in samples if None not in s["bytes"]]
            report["sampled_aggregate_peak_bytes"] = max(complete_samples, default=None)
            report["peak_measurement"] = "sum of four QEMU service memory.current, sampled every 500ms; excludes build and host OS"
            if report["all_vms_verified_stopped"]:
                report["retained_disks"] = [json.loads(run(["qemu-img", "info", "--output=json",
                                                            str(self.root / v["name"] / "disk.qcow2")])) for v in vms]
            report["checks"] = self.evidence
            report["status"] = "passed" if failed is None and report["all_vms_verified_stopped"] else "failed"
            report["finished_at_unix_ms"] = int(time.time()*1000)
            atomic_json(self.root / "report.json", report)
        if failed is not None:
            raise failed
        if report["status"] != "passed":
            raise RuntimeError("lab cleanup incomplete; inspect report and stop explicitly")

    def parallel_routes(self, vms):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            return list(pool.map(lambda vm: self.routes([vm]), vms))


def require(condition, value=True):
    if not condition:
        raise RuntimeError("acceptance assertion failed")
    return value


def expect_error(function):
    try:
        function()
    except RuntimeError as error:
        if "already active/transitioning" not in str(error):
            raise
        return "duplicate start refused"
    raise RuntimeError("duplicate start was incorrectly accepted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "experiment", "status", "stop"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--host-binary")
    parser.add_argument("--port-base", type=int, default=24000)
    parser.add_argument("--rerun", action="store_true", help="keep old evidence, require all VMs stopped, reuse only lab disks")
    args = parser.parse_args()
    lab = Lab(args.root)
    if args.action == "prepare":
        if not args.host_binary:
            parser.error("prepare requires --host-binary")
        lab.prepare(args.host_binary, args.port_base)
    elif args.action == "experiment":
        lab.experiment(rerun=args.rerun)
    elif lab.manifest is None:
        parser.error("lab not prepared")
    elif args.action == "stop":
        for vm in lab.manifest["vms"]:
            lab.stop(vm)
    else:
        print(json.dumps([{**lab.unit_info(vm), "vm": vm["name"], "verified_stopped": lab.stopped(vm)}
                          for vm in lab.manifest["vms"]], indent=2))


if __name__ == "__main__":
    main()
