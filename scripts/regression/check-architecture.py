#!/usr/bin/env python3
"""Reject new internal crate dependencies not present in the frozen baseline.

The first decoupling phase permits deleting dependencies but not adding more.
Intentional new edges require an explicit architecture-baseline review.
"""

import argparse
import json
import runpy
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "config" / "architecture-dependencies.json"
HOST_POLICY = ROOT / "config" / "architecture-host-modules.json"

# Source-level seams that cannot be expressed by Cargo's crate graph yet. Keep
# this list deliberately small: it guards only processors that have completed
# the staged extraction and therefore must not regain transport/Host coupling.
SOURCE_BOUNDARIES = {
    "crates/xharness-host/src/swarm_processor.rs": {
        "BasicHost", "RpcId", "RpcMethod", "ControlStore", "tokio::",
    },
    "crates/xharness-remote/src/creation.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-remote/src/media.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-channel-telegram/src/media.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::", "xharness_api::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },

    "crates/xharness-remote/src/command_replies.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-channel-telegram/src/commands.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::", "xharness_api::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-remote/src/projection.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-channel-telegram/src/output.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::", "xharness_api::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-remote/src/catalogue.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-channel-telegram/src/interactions.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::", "xharness_api::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-remote/src/routing.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-remote/src/tickets.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },

    "crates/xharness-remote/src/administration.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-host-app/src/remote_admin.rs": {
        "xharness_host::", "xharness_core::", "xharness_agent::", "NativeModelSettings",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-remote/src/accounts.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-host-app/src/channel_accounts.rs": {
        "xharness_host::", "xharness_core::", "xharness_agent::", "NativeModelSettings",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-remote/src/outbox.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".call(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-channel-telegram/src/replies.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-channel-telegram/src/intake.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-remote/src/subscription.rs": {
        "BasicHost", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".mux_events(", ".host_events(",
    },
    "crates/xharness-channel-telegram/src/client.rs": {
        "BasicHost", "xharness_host::", "xharness_core::", "xharness_agent::",
        "call_dynamic(", "std::process::",
    },
    "crates/xharness-remote/src/gateway.rs": {
        "BasicHost", "xharness_core::", "xharness_agent::",
        ".call_dynamic(", ".respond(", ".host_events(",
    },
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


# Keep production error handling compiler-enforced at all extracted business
# seams. The scope grows automatically with either architecture declaration.
BUSINESS_ERROR_LINTS = frozenset({
    "clippy::unwrap_used", "clippy::expect_used",
    "clippy::let_underscore_must_use", "unused_must_use",
})
BUSINESS_ERROR_GUARD = "#![deny(" + ",".join(sorted(BUSINESS_ERROR_LINTS)) + ")]\n#![cfg_attr(not(test),forbid(" + ",".join(sorted(BUSINESS_ERROR_LINTS)) + "))]\n"

ERROR_BOUNDARIES = {
    "crates/xharness-host/src/driver_control.rs",
    "crates/xharness-host/src/driver_lifecycle.rs",
    "crates/xharness-host/src/session_recovery.rs",
    "crates/xharness-diagnostics/src/failure.rs",
    "crates/xharness-host/src/event_gateway.rs",
    "crates/xharness-host/src/error_boundary.rs",
}


def business_error_sources(policy: dict) -> set[str]:
    return (set(SOURCE_BOUNDARIES) | ERROR_BOUNDARIES
            | {"crates/xharness-host/src/" + row["source"] for row in policy["managedModules"]})


def module_prologue_attributes(text: str) -> list[str]:
    """Read only real, unconditional inner attributes, before the first item.

    This protects enrollment, not Rust semantics. Real compiler mutations below
    must also reject every forbidden operation, including attempted local allows.
    """
    tail = text.lstrip()
    attributes = []
    while tail:
        if tail.startswith("//"):
            newline = tail.find("\n")
            if newline < 0:
                break
            tail = tail[newline + 1:].lstrip()
        elif tail.startswith("/*"):
            depth, index = 1, 2
            while index < len(tail) and depth:
                if tail.startswith("/*", index):
                    depth += 1
                    index += 2
                elif tail.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            if depth:
                break
            tail = tail[index:].lstrip()
        elif tail.startswith("#!["):
            end = tail.find("]")
            if end < 0:
                break
            attributes.append(tail[3:end])
            tail = tail[end + 1:].lstrip()
        else:
            break
    return attributes


def has_business_error_guards(text: str) -> bool:
    denied, production_forbidden = set(), set()
    for attribute in module_prologue_attributes(text):
        match = re.fullmatch(r"\s*deny\s*\(\s*([\w:,\s]+)\)\s*", attribute)
        if match:
            denied.update(name.strip() for name in match[1].split(",") if name.strip())
        match = re.fullmatch(r"\s*cfg_attr\s*\(\s*not\s*\(\s*test\s*\)\s*,\s*forbid\s*\(\s*([\w:,\s]+)\)\s*,?\s*\)\s*", attribute)
        if match:
            production_forbidden.update(name.strip() for name in match[1].split(",") if name.strip())
    # Tokio's test macro emits allow(expect_used). Keep test builds at deny,
    # but prohibit ALL local overrides in actual production compilation.
    return BUSINESS_ERROR_LINTS <= denied and BUSINESS_ERROR_LINTS <= production_forbidden


def check_business_error_guards(root: Path, policy: dict) -> list[str]:
    errors = []
    config = root / ".clippy.toml"
    expected = {'allow-expect-in-tests = true', 'allow-unwrap-in-tests = true',
                'allow-expect-in-consts = false', 'allow-unwrap-in-consts = false'}
    settings = [line.split("#",1)[0].strip() for line in config.read_text().splitlines()] if config.is_file() else []
    settings = [line for line in settings if line]
    if set(settings) != expected or len(settings) != len(expected):
        errors.append(".clippy.toml: error policy allows assertions only in tests, not production type exemptions")
    for relative in sorted(business_error_sources(policy)):
        path = root / relative
        if not path.is_file() or not has_business_error_guards(path.read_text()):
            errors.append(f"{relative}: requires unconditional deny plus exact non-test forbid of all business error lints")
    return errors


def has_forbid_unsafe_prologue(text: str) -> bool:
    """Require an unconditional module-wide guard before code/other attributes.

    The compiler enforces the body, including nested modules and unsafe fns.
    This check only protects the guard against deletion/downgrade. Comments
    and strings cannot pretend to be an effective Rust inner attribute.
    """
    tail = text.lstrip()
    while tail.startswith(("//", "/*")):
        if tail.startswith("//"):
            newline = tail.find("\n")
            if newline < 0:
                return False
            tail = tail[newline + 1:].lstrip()
            continue
        depth, index = 1, 2
        while index < len(tail) and depth:
            if tail.startswith("/*", index):
                depth += 1
                index += 2
            elif tail.startswith("*/", index):
                depth -= 1
                index += 2
            else:
                index += 1
        if depth:
            return False
        tail = tail[index:].lstrip()
    return re.match(r"^#!\[\s*forbid\s*\(\s*unsafe_code\s*\)\s*\]", tail) is not None


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
        source_text = source.read_text()
        if not has_forbid_unsafe_prologue(source_text):
            errors.append(f"{source_name}: requires unconditional #![forbid(unsafe_code)] at module prologue")
        production = source_text.split("#[cfg(test)]", 1)[0]
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="Full trusted comparison commit for the stabilization freeze")
    args = parser.parse_args()
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
        errors.extend(check_business_error_guards(ROOT, host_policy))

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
    freeze = runpy.run_path(str(Path(__file__).with_name("architecture_freeze.py")))
    return freeze["run"](ROOT, args.base)


if __name__ == "__main__":
    raise SystemExit(main())
