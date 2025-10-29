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


def git_revision(upstream: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True
    ).strip()


def relative_sources(root: Path) -> Iterable[Path]:
    for path in sorted((root / "packages").rglob("*.ts")):
        if any(part in {"node_modules", "lib", "tests"} for part in path.parts):
            continue
        yield path


def literal(expression: str) -> str | None:
    match = re.fullmatch(r"(['\"])([^'\"]+)\1", expression.strip())
    return match.group(2) if match else None


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


def write_matrix(
    output: Path,
    revision: str,
    upstream_rpc: list[str],
    upstream_events: list[str],
    tools: list[Registration],
) -> None:
    rust_rpc = set(rust_rpc_methods())
    rust_events = set(rust_session_events())
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
        f"| Session Event | {len(upstream_events)} | {sum(x in rust_events for x in upstream_events)} | 未覆盖事件进入稳定 TODO |",
        f"| 静态 Literal Tool | {len(tool_literals)} | {sum(x in rust_tools for x in tool_literals)} | 动态 Tool 另行人工审计 |",
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
    rpc = rpc_methods(upstream)
    events = session_events(upstream)
    tools = registrations(upstream, re.compile(r"defineTool\s*\(\s*\{"))
    prompts = registrations(upstream, re.compile(r"systemPrompt\.section\s*\(\s*\{"))
    catalog = {
        "schema_version": 1,
        "upstream": {
            "repository": "https://github.com/deepseek-ai/deepseek-harness",
            "revision": revision,
        },
        "rpc_methods": rpc,
        "session_events": events,
        "tool_registrations": [item.as_json() for item in tools],
        "prompt_section_registrations": [item.as_json() for item in prompts],
        "agent_presets": preset_catalog(upstream),
        "packages": package_names(upstream),
    }
    filename = output / f"upstream-{revision[:10]}.json"
    filename.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    write_matrix(output, revision, rpc, events, tools)
    print(filename)
    print(output / "MATRIX.md")


if __name__ == "__main__":
    main()
