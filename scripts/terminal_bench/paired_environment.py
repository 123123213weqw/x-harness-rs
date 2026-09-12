"""Pinned Harbor Docker integration for the validated restricted transport."""
import shlex
import inspect
import json
import re
import subprocess
from pathlib import Path
from harbor.environments.docker.docker import DockerEnvironment, EnvironmentCapabilities


class EvaluationDocker(DockerEnvironment):
    @property
    def capabilities(self):
        return EnvironmentCapabilities(disable_internet=True, network_allowlist=False,
            dynamic_network_policy=False, windows=False, mounted=True, docker_compose=True)

    @staticmethod
    def _requires_egress_control(*, startup_network_policy, phase_network_policies):
        # All phases use Docker's stronger static network_mode:none plus the
        # private artifact socket. No privileged routing sidecar is needed.
        policies = [startup_network_policy, *phase_network_policies]
        if any(p.network_mode.value != 'no-network' for p in policies):
            raise ValueError('paired evaluation requires no-network in every phase')
        return False

    @property
    def _docker_compose_paths(self):
        return [*super()._docker_compose_paths,
                Path(inspect.getfile(DockerEnvironment)).parent / 'docker-compose-no-network.yaml']

    async def start(self, force_build):
        await super().start(force_build)
        result = await self._run_docker_compose_command(['ps', '-q', 'main'], timeout_sec=10)
        container = result.stdout.strip()
        if not re.fullmatch('[0-9a-f]{64}', container):
            raise RuntimeError('cannot resolve owned trial container')
        row = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True, timeout=10))[0]
        if row['HostConfig']['NetworkMode'] != 'none' or row['HostConfig']['Privileged']:
            raise RuntimeError('trial isolation invariant failed before credentials')
        self.bench_container_id = container

    async def exec(self, command, **kwargs):
        # Also applies to the unchanged verifier entry point. Every child gets
        # the same artifact proxy/cache policy; the real API key is absent.
        wrapped = 'python3 /opt/bench/proxy_exec.py bash -c ' + shlex.quote(command)
        return await super().exec(wrapped, **kwargs)

    async def quiesce(self):
        # Restart ONLY this trial's main container. Its writable filesystem and
        # artifacts survive, but all processes (including detached children)
        # stop before Harbor uploads the hidden verifier.
        await self._run_docker_compose_command(['restart', '--timeout', '1', 'main'], timeout_sec=30)

    async def resource_snapshot(self):
        result = await super().exec(
            'cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/cpu.stat', timeout_sec=10)
        return {'scope': 'whole container since creation, including setup and all descendants',
                'cgroup_v2': result.stdout.strip() if result.return_code == 0 else None}
