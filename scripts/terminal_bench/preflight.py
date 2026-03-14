"""Zero-API-call integration check, run inside the disposable task image."""
import json
import subprocess
import tempfile
import time
from headless import Rpc


def main():
    with tempfile.TemporaryDirectory(prefix="xharness-preflight-") as root:
        process = subprocess.Popen(["/opt/xharness/xharness-host", "--bind", "127.0.0.1:3088",
                                    "--workspace", "/app", "--state-dir", root],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        rpc = Rpc(3088)
        try:
            for _ in range(80):
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read()[-2000:])
                try:
                    settings = rpc.call("settings.describe", {})
                    break
                except (OSError, ValueError, RuntimeError):
                    time.sleep(0.25)
            else:
                raise TimeoutError("host did not become ready")
            permission = next(item for item in settings["namespaces"] if item["ns"] == "permission")
            rpc.call("settings.mutate", {"ns": "permission", "ops": [{"op": "set", "path": ["defaultPreset"], "value": "danger-full-access"}], "expectedRevision": permission["revision"]})
            sid = rpc.call("session.create", {"sessionId": "preflight", "cwd": "/app"})["sessionId"]
            assert sid == "preflight"
            assert not rpc.call("session.history", {"sessionId": sid}).get("running", False)
            print(json.dumps({"actual_host_startup": "passed", "settings": "passed", "session_create": "passed", "model_requests": 0}))
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
