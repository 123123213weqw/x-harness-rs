"""Overlay only the opt-in test/dependencies onto a CI-owned release checkout.

Never apply this helper to a user's working checkout. It does not change product
functions or update dependency versions. Both subjects keep their lockfiles.
"""
import argparse
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("--harness", required=True, type=Path)
parser.add_argument("--subject", required=True, type=Path)
args = parser.parse_args()
source, subject = args.harness.resolve(), args.subject.resolve()
if source == subject or not (subject / ".git").exists():
    raise SystemExit("Expected a separate CI release checkout")
crate = subject / "crates/xharness-host"
test = "dynamic_projection_tests.rs"
if (crate / "src" / test).exists():
    raise SystemExit("Refusing to overwrite an existing test module")
shutil.copyfile(source / "crates/xharness-host/src" / test, crate / "src" / test)
restore = crate / "src/restore.rs"
anchor = "const HISTORY_CHUNK_COALESCE_BYTES: usize = 64 * 1_024;"
text = restore.read_text(encoding="utf-8")
if text.count(anchor) != 1:
    raise SystemExit("Release projection anchor changed")
text = text.replace(anchor, anchor + '\n\n#[cfg(test)]\n#[path = "dynamic_projection_tests.rs"]\nmod dynamic_projection_tests;')
restore.write_text(text, encoding="utf-8")
manifest = crate / "Cargo.toml"
text = manifest.read_text(encoding="utf-8")
before, after = text.split("[dev-dependencies]", 1)
for name in ("xharness-process", "xharness-session-jsonl"):
    if f"{name} =" not in after:
        after = f'\n{name} = {{ path = "../{name}" }}\n' + after
manifest.write_text(before + "[dev-dependencies]" + after, encoding="utf-8")
lock = subject / "Cargo.lock"
text = lock.read_text(encoding="utf-8")
start = text.index('[[package]]\nname = "xharness-host"\n')
end = text.index("\n[[package]]", start + 1)
section = text[start:end]
for name in ("xharness-process", "xharness-session-jsonl"):
    if f' "{name}",' not in section:
        section = section.replace("\n]", f'\n "{name}",\n]', 1)
prefix, rest = section.split("dependencies = [\n", 1)
dependencies, suffix = rest.split("\n]", 1)
section = prefix + "dependencies = [\n" + "\n".join(sorted(dependencies.splitlines())) + "\n]" + suffix
lock.write_text(text[:start] + section + text[end:], encoding="utf-8")
print("Installed identical opt-in test overlay; release product code unchanged")
