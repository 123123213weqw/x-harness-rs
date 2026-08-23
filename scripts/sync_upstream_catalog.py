#!/usr/bin/env python3
"""Generate a deterministic DeepSeek Harness compatibility catalog.

The script is deliberately read-only with respect to the upstream checkout.
It does not install Node dependencies or execute upstream code; it extracts
the checked-in generated RPC/event registries and records static Tool/Prompt
registrations for human review.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UPSTREAM = (
    Path.home()
    / "Documents/Codex/2026-08-13/https-github-com-deepseek-ai-deepseek/deepseek-harness"
)


@dataclass(frozen=True)
class Registration:
    expression: str
    literal: str | None
    source: str
    line: int

    def as_json(self) -> dict[str, object]:
        return {
            "expression": self.expression,
            "literal": self.literal,
            "source": self.source,
            "line": self.line,
        }


@dataclass(frozen=True)
class DynamicRemote:
    endpoint: str | None
    namespace: str | None
    method: str
    class_name: str | None
    source: str
    line: int

    def as_json(self) -> dict[str, object]:
        return {
            "endpoint": self.endpoint,
            "namespace": self.namespace,
            "method": self.method,
            "class": self.class_name,
            "source": self.source,
            "line": self.line,
        }


@dataclass(frozen=True)
class ServiceDefinition:
    class_name: str
    base: str
    key_expression: str
    key: str | None
    source: str
    line: int

    def as_json(self) -> dict[str, object]:
        return {
            "class": self.class_name,
            "base": self.base,
            "key_expression": self.key_expression,
            "key": self.key,
            "source": self.source,
            "line": self.line,
        }


def git_revision(upstream: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True
    ).strip()


def relative_sources(root: Path) -> Iterable[Path]:
    paths: list[Path] = []
    for source_root in (root / "packages", root / "apps"):
        if source_root.exists():
            paths.extend(source_root.rglob("*.ts"))
    for path in sorted(paths):
        if path.name.endswith(".d.ts"):
            continue
        if any(part in {"node_modules", "lib", "tests", "fixtures"} for part in path.parts):
            continue
        yield path


def literal(expression: str) -> str | None:
    match = re.fullmatch(r"(['\"])([^'\"]+)\1", expression.strip())
    return match.group(2) if match else None


def constant_expressions(text: str) -> dict[str, str]:
    pattern = re.compile(
        r"^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)",
        flags=re.MULTILINE,
    )
    return {name: expression.strip() for name, expression in pattern.findall(text)}


def global_literal_constants(upstream: Path) -> dict[str, str]:
    candidates: dict[str, set[str]] = {}
    for path in relative_sources(upstream):
        text = path.read_text(encoding="utf-8", errors="replace")
        for name, expression in constant_expressions(text).items():
            value = literal(expression)
            if value is not None:
                candidates.setdefault(name, set()).add(value)
    return {
        name: next(iter(values))
        for name, values in candidates.items()
        if len(values) == 1
    }


def resolve_expression(
    expression: str,
    local: dict[str, str],
    global_literals: dict[str, str],
    seen: frozenset[str] = frozenset(),
) -> str | None:
    expression = expression.strip()
    value = literal(expression)
    if value is not None:
        return value
    wrapper = re.fullmatch(r"settingsNamespace\s*\(\s*([^()]+)\s*\)", expression)
    if wrapper:
        return resolve_expression(wrapper.group(1), local, global_literals, seen)
    if re.fullmatch(r"[A-Za-z_$][\w$]*", expression):
        if expression in seen:
            return None
        if expression in local:
            return resolve_expression(
                local[expression], local, global_literals, seen | {expression}
            )
        return global_literals.get(expression)
    return None


def registrations(
    upstream: Path, marker: re.Pattern[str], lookahead: int = 900
) -> list[Registration]:
    found: list[Registration] = []
    name_pattern = re.compile(r"\bname\s*:\s*([^,\n}]+)")
    for path in relative_sources(upstream):
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in marker.finditer(text):
            fragment = text[match.end() : match.end() + lookahead]
            name = name_pattern.search(fragment)
            expression = name.group(1).strip() if name else "<dynamic-or-missing>"
            found.append(
                Registration(
                    expression=expression,
                    literal=literal(expression),
                    source=path.relative_to(upstream).as_posix(),
                    line=text.count("\n", 0, match.start()) + 1,
                )
            )
    return sorted(found, key=lambda item: (item.source, item.line, item.expression))


def argument_registrations(
    upstream: Path, marker: re.Pattern[str], global_literals: dict[str, str]
) -> list[Registration]:
    found: list[Registration] = []
    for path in relative_sources(upstream):
        text = path.read_text(encoding="utf-8", errors="replace")
        local = constant_expressions(text)
        for match in marker.finditer(text):
            fragment = text[match.end() : match.end() + 500]
            wrapped = re.match(r"\s*settingsNamespace\s*\(\s*([^()]+)\s*\)", fragment)
            argument = re.match(r"\s*([^,\n)]+)", fragment)
            if wrapped:
                expression = f"settingsNamespace({wrapped.group(1).strip()})"
            else:
                expression = argument.group(1).strip() if argument else "<dynamic-or-missing>"
            found.append(
                Registration(
                    expression=expression,
                    literal=resolve_expression(expression, local, global_literals),
                    source=path.relative_to(upstream).as_posix(),
                    line=text.count("\n", 0, match.start()) + 1,
                )
            )
    return sorted(found, key=lambda item: (item.source, item.line, item.expression))


def service_definitions(
    upstream: Path, global_literals: dict[str, str]
) -> list[ServiceDefinition]:
    found: list[ServiceDefinition] = []
    class_pattern = re.compile(
        r"^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+"
        r"([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*(?:<[^>{}]+>)?)",
        flags=re.MULTILINE,
    )
    super_pattern = re.compile(r"\bsuper\s*\(\s*ctx\s*,\s*([^,)\n]+)")
    for path in relative_sources(upstream):
        text = path.read_text(encoding="utf-8", errors="replace")
        local = constant_expressions(text)
        classes = list(class_pattern.finditer(text))
        for index, match in enumerate(classes):
            base = match.group(2)
            if not (
                base == "Service"
                or base.startswith("Service<")
                or base == "TypertRemoteService"
                or base.startswith("TypertRemoteService<")
            ):
                continue
            end = classes[index + 1].start() if index + 1 < len(classes) else len(text)
            constructor = super_pattern.search(text, match.end(), end)
            expression = (
                constructor.group(1).strip()
                if constructor is not None
                else "<dynamic-or-missing>"
            )
            found.append(
                ServiceDefinition(
                    class_name=match.group(1),
                    base=base,
                    key_expression=expression,
                    key=resolve_expression(expression, local, global_literals),
                    source=path.relative_to(upstream).as_posix(),
                    line=text.count("\n", 0, match.start()) + 1,
                )
            )
    return sorted(found, key=lambda item: (item.source, item.line, item.class_name))


def service_provisions(
    upstream: Path, global_literals: dict[str, str]
) -> list[Registration]:
    return argument_registrations(
        upstream, re.compile(r"^\s*ctx\.provide\s*\(", flags=re.MULTILINE), global_literals
    )


def dynamic_remotes(upstream: Path) -> list[DynamicRemote]:
    found: list[DynamicRemote] = []
    class_pattern = re.compile(
        r"^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+"
        r"([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*(?:<[^>{}]+>)?)",
        flags=re.MULTILINE,
    )
    decorator_pattern = re.compile(
        r"^\s*@Remote(?:\(\s*(['\"])([^'\"]+)\1\s*\))?\s*$",
        flags=re.MULTILINE,
    )
    super_pattern = re.compile(r"\bsuper\s*\(\s*ctx\s*,\s*(['\"])([^'\"]+)\1")
    method_pattern = re.compile(
        r"\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?"
        r"([A-Za-z_$][\w$]*)\s*\("
    )
    for path in relative_sources(upstream):
        text = path.read_text(encoding="utf-8", errors="replace")
        classes = list(class_pattern.finditer(text))
        for decorator in decorator_pattern.finditer(text):
            owner_index = None
            for index, class_match in enumerate(classes):
                next_start = classes[index + 1].start() if index + 1 < len(classes) else len(text)
                if class_match.start() < decorator.start() < next_start:
                    owner_index = index
                    break
            owner = classes[owner_index] if owner_index is not None else None
            owner_end = (
                classes[owner_index + 1].start()
                if owner_index is not None and owner_index + 1 < len(classes)
                else len(text)
            )
            namespace_match = (
                super_pattern.search(text, owner.end(), owner_end)
                if owner is not None
                else None
            )
            namespace = namespace_match.group(2) if namespace_match else None
            declared_method = method_pattern.match(text, decorator.end())
            method = decorator.group(2) or (
                declared_method.group(1) if declared_method else "<dynamic-or-missing>"
            )
            endpoint = f"{namespace}/{method}" if namespace and not method.startswith("<") else None
            found.append(
                DynamicRemote(
                    endpoint=endpoint,
                    namespace=namespace,
                    method=method,
                    class_name=owner.group(1) if owner is not None else None,
                    source=path.relative_to(upstream).as_posix(),
                    line=text.count("\n", 0, decorator.start()) + 1,
                )
            )
    return sorted(found, key=lambda item: (item.endpoint or "", item.source, item.line))


def frame_discriminants(upstream: Path, type_name: str, next_type: str | None) -> list[str]:
    path = upstream / "packages/host/apiproxy/src/api/events.ts"
    text = path.read_text(encoding="utf-8")
    start = text.index(f"export type {type_name} =")
    end = text.index(f"export type {next_type} =", start) if next_type else len(text)
    return list(dict.fromkeys(re.findall(r"\btype:\s*'([^']+)'", text[start:end])))


def forwarded_remote_events(upstream: Path) -> list[str]:
    path = upstream / "packages/api/remotes/src/remote-events.ts"
    text = path.read_text(encoding="utf-8")
    start = text.index("API_REMOTE_FORWARDED_EVENTS = [")
    end = text.index("] as const", start)
    return re.findall(r"'([^']+)'", text[start:end])


def settings_registrations(
    upstream: Path, global_literals: dict[str, str]
) -> list[Registration]:
    return argument_registrations(
        upstream, re.compile(r"\b[A-Za-z_$][\w$]*\.settings\.register\s*\("), global_literals
    )


def rpc_methods(upstream: Path) -> list[str]:
    path = upstream / "packages/host/apiproxy/src/api/rpc-map.ts"
    text = path.read_text(encoding="utf-8")
    return re.findall(r"^\s*'([^']+)'\s*:", text, flags=re.MULTILINE)


def session_events(upstream: Path) -> list[str]:
    path = upstream / "packages/core/session/src/known-event-types.ts"
    text = path.read_text(encoding="utf-8")
    start = text.index("new Set([")
    end = text.index("])", start)
    return re.findall(r"'([^']+)'", text[start:end])


def rust_rpc_methods() -> list[str]:
    text = (ROOT / "crates/xharness-api/src/lib.rs").read_text(encoding="utf-8")
    return re.findall(r"=>\s*\"([^\"]+)\"", text)


def rust_session_events() -> list[str]:
    text = (ROOT / "crates/xharness-session/src/event.rs").read_text(encoding="utf-8")
    return re.findall(r"#\[serde\(rename\s*=\s*\"([^\"]+)\"\)\]", text)


def rust_dynamic_remotes() -> list[str]:
    text = (ROOT / "crates/xharness-host/src/rpc.rs").read_text(encoding="utf-8")
    return re.findall(r'^\s*"([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)"\s*=>', text, flags=re.MULTILINE)


def rust_frame_discriminants(enum_name: str, next_enum: str | None) -> list[str]:
    text = (ROOT / "crates/xharness-api/src/lib.rs").read_text(encoding="utf-8")
    start = text.index(f"pub enum {enum_name}")
    if next_enum:
        next_declaration = re.search(
            rf"pub\s+(?:enum|struct)\s+{re.escape(next_enum)}\b", text[start:]
        )
        if next_declaration is None:
            raise ValueError(f"Rust declaration {next_enum!r} not found after {enum_name!r}")
        end = start + next_declaration.start()
    else:
        end = len(text)
    return list(
        dict.fromkeys(
            re.findall(r'#\[serde\(rename\s*=\s*"([^"]+)"', text[start:end])
        )
    )


def preset_catalog(upstream: Path) -> list[dict[str, str]]:
    root = upstream / "apps/cli/config/agent-presets"
    presets: list[dict[str, str]] = []
    for path in sorted(root.glob("*/preset.yml")):
        text = path.read_text(encoding="utf-8", errors="replace")
        values: dict[str, str] = {"directory": path.parent.name}
        for key in ("id", "name", "description"):
            match = re.search(rf"^{key}:\s*(.+?)\s*$", text, flags=re.MULTILINE)
            if match:
                values[key] = match.group(1).strip(" '\"")
        values["source"] = path.relative_to(upstream).as_posix()
        presets.append(values)
    return presets


def package_names(upstream: Path) -> list[str]:
    names: list[str] = []
    for path in sorted((upstream / "packages").rglob("package.json")):
        if "node_modules" in path.parts:
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        name = value.get("name")
        if isinstance(name, str):
            names.append(name)
    return sorted(set(names))


def validate_catalog(
    rpc: list[str],
    remotes: list[DynamicRemote],
    mux_frames: list[str],
    host_frames: list[str],
    events: list[str],
) -> None:
    def require_unique(label: str, values: list[str]) -> None:
        duplicates = sorted({value for value in values if values.count(value) > 1})
        if duplicates:
            raise ValueError(f"duplicate {label}: {duplicates}")

    require_unique("fixed RPC method", rpc)
    require_unique("Mux frame", mux_frames)
    require_unique("Host frame", host_frames)
    require_unique("Session event", events)
    unresolved = [item for item in remotes if item.endpoint is None]
    if unresolved:
        locations = [f"{item.source}:{item.line}" for item in unresolved]
        raise ValueError(f"unresolved dynamic Remote registration: {locations}")
    require_unique(
        "dynamic Remote endpoint",
        [item.endpoint for item in remotes if item.endpoint is not None],
    )


def write_matrix(
    output: Path,
    revision: str,
    upstream_rpc: list[str],
    upstream_events: list[str],
    tools: list[Registration],
    remotes: list[DynamicRemote],
    mux_frames: list[str],
    host_frames: list[str],
    settings: list[Registration],
    services: list[ServiceDefinition],
    remote_events: list[str],
    prompt_sections: list[Registration],
    prompt_contexts: list[Registration],
    prompt_tool_providers: list[Registration],
    prompt_variables: list[Registration],
    provisions: list[Registration],
) -> None:
    rust_rpc = set(rust_rpc_methods())
    rust_events = set(rust_session_events())
    rust_remotes = set(rust_dynamic_remotes())
    rust_mux_frames = set(rust_frame_discriminants("MuxFrame", "HostFrame"))
    rust_host_frames = set(rust_frame_discriminants("HostFrame", "ClientResponse"))
    rust_tools = {
        "bash",
        "read",
        "write",
        "edit",
        "glob",
        "grep",
        "terminal_open",
        "terminal_send",
        "terminal_read",
        "terminal_signal",
        "terminal_close",
        "terminal_list",
        "web_search",
        "web_fetch",
    }
    tool_literals = sorted({item.literal for item in tools if item.literal})
    remote_endpoints = sorted({item.endpoint for item in remotes if item.endpoint})
    setting_namespaces = sorted({item.literal for item in settings if item.literal})
    service_keys = sorted({item.key for item in services if item.key})
    rust_settings = {"ui-onboarding", "permission", "xharness"}
    rust_remote_events = {"settings/document-updated"}
    prompt_total = (
        len(prompt_sections)
        + len(prompt_contexts)
        + len(prompt_tool_providers)
        + len(prompt_variables)
    )

    lines = [
        "# DeepSeek Harness 兼容矩阵",
        "",
        f"**冻结上游：** `deepseek-harness@{revision[:10]}`  ",
        "**生成方式：** `scripts/sync_upstream_catalog.py`，只读静态抽取。",
        "",
        "## 汇总",
        "",
        "| 目录 | 上游数量 | Rust 已覆盖 | 说明 |",
        "| --- | ---: | ---: | --- |",
        f"| 固定 RPC | {len(upstream_rpc)} | {sum(x in rust_rpc for x in upstream_rpc)} | 名称 exact，业务语义仍按方法验收 |",
        f"| 动态 Typert RPC | {len(remote_endpoints)} | {sum(x in rust_remotes for x in remote_endpoints)} | 端点由 Service Namespace + Remote Method 组成 |",
        f"| Mux Frame | {len(mux_frames)} | {sum(x in rust_mux_frames for x in mux_frames)} | 判别字段名称 exact，业务字段另测 |",
        f"| Host Frame | {len(host_frames)} | {sum(x in rust_host_frames for x in host_frames)} | 判别字段名称 exact，业务字段另测 |",
        f"| Forwarded Host Event | {len(remote_events)} | {sum(x in rust_remote_events for x in remote_events)} | Frame 通用形状已支持，生产者逐项迁移 |",
        f"| Session Event | {len(upstream_events)} | {sum(x in rust_events for x in upstream_events)} | 未覆盖事件进入稳定 TODO |",
        f"| 静态 Literal Tool | {len(tool_literals)} | {sum(x in rust_tools for x in tool_literals)} | 动态 Tool 另行人工审计 |",
        f"| Prompt Component | {prompt_total} | — | Section/Context/Tool Provider/Variable 分开记录 |",
        f"| Settings Namespace | {len(setting_namespaces)} | {sum(x in rust_settings for x in setting_namespaces)} | Rust 当前仅有产品启动所需基线 |",
        f"| Service Definition | {len(services)} | — | {len(service_keys)} 个静态 Key，Rust 用 Trait/Registry 等价替代 |",
        f"| Service Provision | {len(provisions)} | — | ctx.provide 组合点保留表达式和来源 |",
        "",
        "## 固定 RPC",
        "",
        "| 上游方法 | Rust | 等级 |",
        "| --- | --- | --- |",
    ]
    for name in upstream_rpc:
        covered = name in rust_rpc
        lines.append(f"| `{name}` | {'是' if covered else '否'} | `{'partial' if covered else 'planned'}` |")

    lines.extend(
        [
            "",
            "## 动态 Typert RPC",
            "",
            "| 上游端点 | Rust | 等级 |",
            "| --- | --- | --- |",
        ]
    )
    for name in remote_endpoints:
        covered = name in rust_remotes
        lines.append(
            f"| `{name}` | {'是' if covered else '否'} | `{'partial' if covered else 'planned'}` |"
        )

    for title, names, covered_names in (
        ("Mux Frame", mux_frames, rust_mux_frames),
        ("Host Frame", host_frames, rust_host_frames),
    ):
        lines.extend(
            [
                "",
                f"## {title}",
                "",
                "| 判别值 | Rust 强类型 Frame | 等级 |",
                "| --- | --- | --- |",
            ]
        )
        for name in names:
            covered = name in covered_names
            lines.append(
                f"| `{name}` | {'是' if covered else '否'} | `{'behavioral' if covered else 'planned'}` |"
            )

    lines.extend(
        [
            "",
            "## Forwarded Host Event",
            "",
            "`host/remote-event` 的通用 Frame 已实现；下表表示 Rust Host 是否已有对应生产者。",
            "",
            "| 事件 | Rust 生产者 | 等级 |",
            "| --- | --- | --- |",
        ]
    )
    for name in remote_events:
        covered = name in rust_remote_events
        lines.append(
            f"| `{name}` | {'是' if covered else '否'} | `{'partial' if covered else 'planned'}` |"
        )

    lines.extend(
        [
            "",
            "## Session Event",
            "",
            "| 上游事件 | Rust 强类型事件 | 等级 |",
            "| --- | --- | --- |",
        ]
    )
    for name in upstream_events:
        covered = name in rust_events
        lines.append(
            f"| `{name}` | {'是' if covered else '否'} | `{'partial' if covered else 'planned'}` |"
        )

    lines.extend(
        [
            "",
            "## 静态 Literal Tool",
            "",
            "该表是全仓库静态注册目录，不代表某个 Preset 会同时向模型发送全部工具。",
            "",
            "| 工具 | Rust 原生 Tool | 等级 |",
            "| --- | --- | --- |",
        ]
    )
    for name in tool_literals:
        covered = name in rust_tools
        lines.append(
            f"| `{name}` | {'是' if covered else '否'} | `{'partial' if covered else 'planned'}` |"
        )

    lines.extend(
        [
            "",
            "## Prompt Component",
            "",
            "| 类型 | 上游注册点 | Rust 状态 |",
            "| --- | ---: | --- |",
            f"| Section | {len(prompt_sections)} | `planned` |",
            f"| Runtime Context | {len(prompt_contexts)} | `planned` |",
            f"| Tool Provider | {len(prompt_tool_providers)} | `planned` |",
            f"| Variable | {len(prompt_variables)} | `planned` |",
            "",
            "每个注册点的名称/表达式、文件和行号位于机器可读 JSON；这里不把 UI Preset 文本误算为运行时 Section。",
        ]
    )

    lines.extend(
        [
            "",
            "## Settings Namespace",
            "",
            "| 上游 Namespace | Rust | 等级 |",
            "| --- | --- | --- |",
        ]
    )
    for name in setting_namespaces:
        covered = name in rust_settings
        lines.append(
            f"| `{name}` | {'是' if covered else '否'} | `{'partial' if covered else 'planned'}` |"
        )

    lines.extend(
        [
            "",
            "## Service Definition",
            "",
            "Service 是上游 Cordis 组合目录；Rust 是否完成以对应 Trait/Registry 的行为验收为准，",
            "此表不把同名 Class 当作复刻目标。完整 Class、Base、Key 与来源位于机器可读 JSON。",
            "",
            f"已记录 `{len(services)}` 个定义，其中 `{len(service_keys)}` 个是静态 Service Key；动态或缺失 Key 保留原表达式供人工审计。",
            f"另记录 `{len(provisions)}` 个 `ctx.provide(...)` 组合点。",
        ]
    )
    (output / "MATRIX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/compat")
    args = parser.parse_args()

    upstream = args.upstream.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not (upstream / ".git").exists():
        raise SystemExit(f"not an upstream git checkout: {upstream}")
    output.mkdir(parents=True, exist_ok=True)

    revision = git_revision(upstream)
    global_literals = global_literal_constants(upstream)
    rpc = rpc_methods(upstream)
    remotes = dynamic_remotes(upstream)
    mux_frames = frame_discriminants(upstream, "MuxFrame", "HostFrame")
    host_frames = frame_discriminants(upstream, "HostFrame", None)
    remote_events = forwarded_remote_events(upstream)
    events = session_events(upstream)
    validate_catalog(rpc, remotes, mux_frames, host_frames, events)
    tools = registrations(upstream, re.compile(r"defineTool\s*\(\s*\{"))
    prompt_sections = registrations(
        upstream, re.compile(r"systemPrompt\.section\s*\(\s*\{")
    )
    prompt_contexts = registrations(
        upstream, re.compile(r"systemPrompt\.context\s*\(\s*\{")
    )
    prompt_tool_providers = argument_registrations(
        upstream, re.compile(r"systemPrompt\.tools\s*\("), global_literals
    )
    prompt_variables = argument_registrations(
        upstream, re.compile(r"systemPrompt\.variable\s*\("), global_literals
    )
    settings = settings_registrations(upstream, global_literals)
    services = service_definitions(upstream, global_literals)
    provisions = service_provisions(upstream, global_literals)
    catalog = {
        "schema_version": 2,
        "upstream": {
            "repository": "https://github.com/deepseek-ai/deepseek-harness",
            "revision": revision,
        },
        "rpc_methods": rpc,
        "dynamic_remote_registrations": [item.as_json() for item in remotes],
        "mux_frame_discriminants": mux_frames,
        "host_frame_discriminants": host_frames,
        "forwarded_remote_events": remote_events,
        "session_events": events,
        "tool_registrations": [item.as_json() for item in tools],
        "prompt_section_registrations": [item.as_json() for item in prompt_sections],
        "prompt_context_registrations": [item.as_json() for item in prompt_contexts],
        "prompt_tool_provider_registrations": [
            item.as_json() for item in prompt_tool_providers
        ],
        "prompt_variable_registrations": [item.as_json() for item in prompt_variables],
        "settings_registrations": [item.as_json() for item in settings],
        "service_definitions": [item.as_json() for item in services],
        "service_provisions": [item.as_json() for item in provisions],
        "agent_presets": preset_catalog(upstream),
        "packages": package_names(upstream),
    }
    filename = output / f"upstream-{revision[:10]}.json"
    filename.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    write_matrix(
        output,
        revision,
        rpc,
        events,
        tools,
        remotes,
        mux_frames,
        host_frames,
        settings,
        services,
        remote_events,
        prompt_sections,
        prompt_contexts,
        prompt_tool_providers,
        prompt_variables,
        provisions,
    )
    print(filename)
    print(output / "MATRIX.md")


if __name__ == "__main__":
    main()
