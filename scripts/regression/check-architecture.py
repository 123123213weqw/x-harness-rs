#!/usr/bin/env python3
"""Reject new internal crate dependencies not present in the frozen baseline.

The first decoupling phase permits deleting dependencies but not adding more.
Intentional new edges require an explicit architecture-baseline review.
"""

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "config" / "architecture-dependencies.json"


def production_dependencies(manifest: Path) -> set[str]:
    section = ""
    dependencies: set[str] = set()
    for raw in manifest.read_text().splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue
        is_dependency_section = section == "dependencies" or (
            section.startswith("target.") and section.endswith(".dependencies")
        )
        if not is_dependency_section or line.startswith("#"):
            continue
        match = re.match(r"^(xharness-[A-Za-z0-9_-]+)\s*=", line)
        if match:
            dependencies.add(match.group(1))
    return dependencies


def main() -> int:
    expected = {key: set(value) for key, value in json.loads(BASELINE.read_text()).items()}
    manifests = sorted((ROOT / "crates").glob("*/Cargo.toml"))
    actual = {}
    for manifest in manifests:
        package = re.search(r'(?m)^name\s*=\s*"(xharness-[^"]+)"', manifest.read_text())
        if package:
            actual[package.group(1)] = production_dependencies(manifest)

    errors = []
    unexpected_crates = set(actual) - set(expected)
    if unexpected_crates:
        errors.append(
            "new crates require architecture review: " + ", ".join(sorted(unexpected_crates))
        )
    for crate, dependencies in actual.items():
        additions = dependencies - expected.get(crate, set())
        if additions:
            errors.append(f"{crate}: new internal dependencies: {', '.join(sorted(additions))}")
    missing_crates = set(expected) - set(actual)
    if missing_crates:
        errors.append("baseline references missing crates: " + ", ".join(sorted(missing_crates)))

    if errors:
        print("architecture dependency regression:")
        for error in errors:
            print(f"- {error}")
        print("Remove the edge or update config/architecture-dependencies.json in an explicit architecture review.")
        return 1

    removed = {
        crate: sorted(expected[crate] - actual.get(crate, set()))
        for crate in expected
        if expected[crate] - actual.get(crate, set())
    }
    print(f"architecture dependency boundary passed for {len(actual)} crates")
    for crate, dependencies in removed.items():
        print(f"- improved {crate}: removed {', '.join(dependencies)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
