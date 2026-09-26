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
HOST_POLICY = ROOT / "config" / "architecture-host-modules.json"

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


def check_managed_host_modules(root: Path, policy: dict) -> list[str]:
    """Enforce the declared owner, dependency and integration seams of extracted Host policy."""
    errors: list[str] = []
    host = root / "crates" / "xharness-host" / "src"
    lib = (host / "lib.rs").read_text()
    sources = list(host.rglob("*.rs"))
    seen_sources: set[str] = set()
    seen_owners: set[str] = set()
    for module in policy["managedModules"]:
        source_name = module["source"]
        owner = module["stateOwner"].strip()
        if not owner or owner in seen_owners:
            errors.append(f"managed Host module needs a unique state owner: {source_name}")
        seen_owners.add(owner)
        if source_name in seen_sources:
            errors.append(f"duplicate managed Host module: {source_name}")
        seen_sources.add(source_name)
        paths = [source_name, module["entrypoint"], *module["allowedConsumers"]]
        if any(Path(value).is_absolute() or ".." in Path(value).parts for value in paths):
            errors.append(f"managed Host module has an unsafe path: {source_name}")
            continue
        source = host / source_name
        entrypoint = host / module["entrypoint"]
        if not source.is_file() or not entrypoint.is_file():
            errors.append(f"managed Host module missing source or entrypoint: {source_name}")
            continue
        for consumer in module["allowedConsumers"]:
            if not (host / consumer).is_file():
                errors.append(f"managed Host module has a missing allowed consumer: {consumer}")
        stem = Path(source_name).stem
        if not re.search(rf"(?m)^mod {re.escape(stem)};\s*$", lib):
            errors.append(f"managed Host module not declared in lib.rs: {source_name}")
        if f"{stem}::" not in entrypoint.read_text():
            errors.append(f"managed Host entrypoint does not use {source_name}")
        production = source.read_text().split("#[cfg(test)]", 1)[0]
        actual_crates = set(re.findall(r"\bxharness_\w+(?=::)", production))
        unexpected = actual_crates - set(module["allowedCrates"])
        if unexpected:
            errors.append(f"{source_name}: undeclared internal crates: {', '.join(sorted(unexpected))}")
        allowed = {source_name, module["entrypoint"], *module["allowedConsumers"]}
        for candidate in sources:
            relative = candidate.relative_to(host).as_posix()
            if relative in allowed or relative.endswith("_tests.rs"):
                continue
            if f"{stem}::" in candidate.read_text():
                errors.append(f"{relative}: bypasses {source_name} integration entrypoint")
    return errors


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

    host_policy = json.loads(HOST_POLICY.read_text())
    if host_policy.get("version") != 1:
        errors.append("unsupported managed Host architecture policy version")
    else:
        errors.extend(check_managed_host_modules(ROOT, host_policy))

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
