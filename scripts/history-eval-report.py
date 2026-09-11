"""Independently check explicit isolated evaluation directories, aggregate usage."""
import json
from pathlib import Path
import subprocess
import sys


def evaluate(root):
    metrics = json.loads((root / "metrics.json").read_text())
    recovery = metrics["case"] == "recovery"
    config = dict(source=(root / "work/retry.py").read_text(),
                  base=173 if recovery else 137,
                  cap=6 if recovery else 7,
                  ceiling=7301 if recovery else 9000)
    try:
        result = subprocess.run(
            [sys.executable, "-I", str(Path(__file__).with_name("history-eval-acceptance.py"))],
            input=json.dumps(config), text=True, capture_output=True,
            timeout=3, env={}, check=True,
        )
        acceptance = json.loads(result.stdout)
    except (subprocess.SubprocessError, ValueError) as error:
        acceptance = {"ok": False, "error": type(error).__name__}
    metrics["acceptance"] = acceptance
    metrics["run"] = root.name
    usage = metrics["usage"]
    metrics["total_input_tokens"] = sum(usage[k] for k in ["input_tokens", "cache_read_tokens", "cache_write_tokens"])
    metrics["total_output_tokens"] = usage["output_tokens"] + usage["reasoning_tokens"]
    (root / "checked.json").write_text(json.dumps(metrics, indent=2))
    return metrics


if __name__ == "__main__":
    print(json.dumps([evaluate(Path(arg).resolve()) for arg in sys.argv[1:]], indent=2))
