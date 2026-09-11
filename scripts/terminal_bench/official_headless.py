"""Thin process wrapper for official dsh 0.1.5-rc.1 full headless.

EXPERIMENTAL: native-tool mock has not passed; not wired into paid trials.
No replacement prompt, tool loop, compactor or SDK-minimal composition. Real
provider credentials remain outside the container; stdin carries a capability.
"""
import json
import os
from pathlib import Path, PurePosixPath
import signal
import subprocess
import sys
import time
from relay import Relay


def provider_patch(base_url, context, output):
    return [{'id': 'llm-deepseek', 'config': {
        'apiKeyEnv': 'DEEPSEEK_API_KEY', 'baseURL': base_url,
        'thinking': 'enabled', 'reasoningEffort': 'high', 'maxTokens': output,
        'defaultContextWindow': context,
        'models': [{'id': 'deepseek-flash', 'name': 'DeepSeek-V41-Flash',
                    'contextWindow': context, 'maxTokens': output,
                    'inputModalities': ['text', 'image'],
                    'imagePixelBudget': 640000, 'imageMaxBytes': 1048576,
                    'systemPromptUpdate': 'in-history'}]}}]


def launch_command(runtime, patch, instruction):
    root = PurePosixPath(runtime)
    return [str(root / 'node'), str(root / 'dsh-official/node_modules/@deepseek-ai/dsh/lib/bin.js'),
            '--profile', 'headless', '--patch', str(patch), instruction]


def runtime_environment(root, capability, base_url):
    return {'PATH': '/opt/official:/usr/local/bin:/usr/bin:/bin', 'HOME': str(PurePosixPath(root) / 'user'),
            'LANG': 'C.UTF-8', 'DSH_HOME': str(PurePosixPath(root) / 'home'),
            'DEEPSEEK_API_KEY': capability, 'DEEPSEEK_BASE_URL': base_url,
            'DSH_PERMISSION_MODE': 'danger-full-access', 'DSH_TELEMETRY_MODE': 'DISABLED',
            'UV_USE_IO_URING': '0'}


def stop_process_group(process):
    # The leader may exit before its children. Waiting only for the leader
    # cannot prove the process group is gone before a verifier is injected.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
    # Detached descendants still require container-level quiescence before
    # grading. This standalone mock removes its owned container on exit.


def main():
    config = json.load(sys.stdin)
    root = Path('/logs/agent/official')
    root.mkdir(parents=True, exist_ok=False)
    (root / 'user').mkdir()
    relay = Relay()
    report = {'status': 'adapter_error', 'variant': 'official-full-headless', 'version': '0.1.5-rc.1'}
    started = time.monotonic()
    process = None
    try:
        patch = root / 'provider.patch.json'
        patch.write_text(json.dumps(provider_patch(relay.url, config['context_window'], config['max_output_tokens'])))
        env = runtime_environment(root, config.pop('capability'), relay.url)
        with (root / 'stdout.log').open('w') as stdout, (root / 'stderr.log').open('w') as stderr:
            process = subprocess.Popen(launch_command('/opt/official', patch, config['instruction']),
                                       env=env, stdout=stdout, stderr=stderr, start_new_session=True)
            env.pop('DEEPSEEK_API_KEY')
            try:
                report['exit_code'] = process.wait(timeout=config['seconds'])
                report['status'] = 'settled' if report['exit_code'] == 0 else 'agent_error'
            except subprocess.TimeoutExpired:
                report['status'] = 'timeout'
    except (OSError, ValueError, KeyError) as error:
        report['error_type'] = type(error).__name__
    finally:
        if process is not None:
            stop_process_group(process)
        relay.stop()
        report['elapsed_seconds'] = time.monotonic() - started
        (root / 'adapter.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    return 124 if report['status'] == 'timeout' else (0 if report['status'] == 'settled' else 1)


if __name__ == '__main__':
    sys.exit(main())
