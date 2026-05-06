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

# Source-level seams that cannot be expressed by Cargo's crate graph yet. Keep
# this list deliberately small: it guards only processors that have completed
# the staged extraction and therefore must not regain transport/Host coupling.
SOURCE_BOUNDARIES = {
    "crates/xharness-host/src/credential_processor.rs": {
        "BasicHost",
        "RpcId",
        "RpcMethod",
        "ControlStore",
        "tokio::",
    },
    "crates/xharness-host/src/preset_processor.rs": {
        "BasicHost",
        "RpcId",
        "RpcMethod",
        "ControlStore",
        "tokio::",
    },
    "crates/xharness-host/src/settings_processor.rs": {
        "BasicHost",
        "RpcId",
        "RpcMethod",
        "ControlStore",
        "tokio::",
    },
    "crates/xharness-host/src/workspace_processor.rs": {
        "BasicHost",
        "RpcId",
        "RpcMethod",
        "ControlStore",
        "tokio::",
    },
    "crates/xharness-host/src/model_processor.rs": {
        "BasicHost",
        "RpcId",
        "RpcMethod",
        "ControlStore",
        "tokio::",
    },
    "crates/xharness-host/src/subagent_processor.rs": {
        "BasicHost",
        "RpcId",
        "RpcMethod",
        "ControlStore",
        "tokio::",
    },
    "crates/xharness-host/src/goal_processor.rs": {
        "BasicHost",
        "RpcId",
        "RpcMethod",
        "ControlStore",
        "tokio::",
    },
    "crates/xharness-host/src/session_processor.rs": {
        "BasicHost",
        "RpcId",
        "RpcMethod",
        "ControlStore",
        "tokio::",
    },
}

# Transport modules may mention `BasicHost` in trait adapters, but may not grow
# a second collection of domain methods on the aggregate again.
FORBIDDEN_SOURCE_FRAGMENTS = {
    "crates/xharness-host/src/rpc.rs": {"impl BasicHost {"},
}


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

    for relative, forbidden_tokens in SOURCE_BOUNDARIES.items():
        source = ROOT / relative
        if not source.is_file():
            errors.append(f"source boundary target is missing: {relative}")
            continue
        text = source.read_text()
        found = sorted(token for token in forbidden_tokens if token in text)
        if found:
            errors.append(f"{relative}: forbidden coupling: {', '.join(found)}")

    for relative, forbidden_fragments in FORBIDDEN_SOURCE_FRAGMENTS.items():
        source = ROOT / relative
        if not source.is_file():
            errors.append(f"source boundary target is missing: {relative}")
            continue
        text = source.read_text()
        found = sorted(fragment for fragment in forbidden_fragments if fragment in text)
        if found:
            errors.append(f"{relative}: forbidden legacy handler: {', '.join(found)}")

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
    print(
        f"architecture dependency boundary passed for {len(actual)} crates "
        f"and {len(SOURCE_BOUNDARIES)} extracted processors"
    )
    for crate, dependencies in removed.items():
        print(f"- improved {crate}: removed {', '.join(dependencies)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
