"""Diff-aware stabilization gate. Tool handlers/schema catalogues are not frozen.

A record is an auditable compatibility/test plan, not proof of human approval or
semantic compatibility. Existing native/wire/recovery tests remain authoritative.
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess

POLICY = "config/architecture-freeze.json"
RECORDS = "config/architecture-changes/"
GROUPS = {"architecture", "native", "windows", "wire", "persistence", "updater"}


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)


def relative(value: object) -> bool:
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or any(ord(c) < 32 for c in value):
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and path.as_posix() == value and ".." not in path.parts


def load_policy(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"schema", "layers", "flexible"} or type(value["schema"]) is not int or value["schema"] != 1:
        raise ValueError("unsupported freeze policy")
    ids = set()
    for row in value["layers"]:
        if set(row) != {"id", "paths", "regressions"} or not re.fullmatch(r"[a-z][a-z-]+", row["id"]) or row["id"] in ids:
            raise ValueError("freeze layers need unique IDs and exact fields")
        ids.add(row["id"])
        if not row["paths"] or any(not relative(p) for p in row["paths"]):
            raise ValueError("freeze paths must be nonempty repository-relative patterns")
        if not row["regressions"] or not set(row["regressions"]) <= GROUPS:
            raise ValueError("unknown or empty freeze regression group")
    if not ids or not value["flexible"] or any(not relative(p) for p in value["flexible"]):
        raise ValueError("freeze policy needs layers and explicit flexible tool paths")
    return value


def layers_for(path: str, policy: dict) -> list[dict]:
    return [row for row in policy["layers"] if any(fnmatch.fnmatchcase(path, p) for p in row["paths"])]


def changed_paths(root: Path, base: str) -> set[str]:
    # No rename detection: both old and new paths must be accounted for.
    tracked = git(root, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, "--")
    untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z")
    return {p.decode("utf-8") for p in (tracked + untracked).split(b"\0") if p}


def before(root: Path, base: str, path: str) -> bytes | None:
    # Distinguish an absent file from an object/database error. No shell or
    # revision supplied by a record is executed; base is resolved once below.
    exists = subprocess.run(["git", "-C", str(root), "cat-file", "-e", f"{base}:{path}"], capture_output=True)
    if exists.returncode:
        if git(root, "ls-tree", "--name-only", base, "--", path).strip():
            raise ValueError(f"cannot read base object: {path}")
        return None
    return git(root, "show", f"{base}:{path}")


def after(root: Path, path: str) -> bytes | None:
    file = root / path
    if file.is_symlink() or not file.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"freeze-controlled files must be regular paths inside the repository: {path}")
    return file.read_bytes() if file.is_file() else None


def digest(content: bytes | None) -> str | None:
    return None if content is None else hashlib.sha256(content.replace(b"\r\n", b"\n")).hexdigest()


def pins(root: Path, base: str) -> list[str]:
    """Two narrow hard compatibility checks; not a general Rust ABI parser."""
    errors = []
    path = "apps/desktop/src-tauri/tauri.conf.json"
    old, new = before(root, base, path), after(root, path)
    if old is not None:
        if new is None:
            errors.append("desktop identity config cannot be deleted during stabilization")
        else:
            a, b = json.loads(old), json.loads(new)
            for label, left, right in [
                ("application identifier", a.get("identifier"), b.get("identifier")),
                ("Windows installation mode", a.get("bundle", {}).get("windows", {}).get("nsis", {}).get("installMode"), b.get("bundle", {}).get("windows", {}).get("nsis", {}).get("installMode")),
            ]:
                if left != right:
                    errors.append(f"frozen {label} changed; a compatibility record cannot waive identity migration")
    path = "crates/xharness-api/src/lib.rs"
    old, new = before(root, base, path), after(root, path)
    if old is not None:
        def names(source: bytes | None) -> set[str]:
            text = (source or b"").decode("utf-8")
            block = re.search(r"(?ms)^rpc_methods!\s*\{(.*?)^\}", text)
            if not block:
                raise ValueError("RPC catalogue is missing or no longer inspectable")
            values = re.findall(r'^\s*\w+\s*=>\s*"([^"]+)"\s*,?\s*$', block[1], re.M)
            if not values or len(values) != len(set(values)):
                raise ValueError("RPC catalogue must have unique literal wire names")
            return set(values)
        removed = names(old) - names(new)
        if removed:
            errors.append("frozen RPC names removed/renamed: " + ", ".join(sorted(removed)))
    return errors


def check(root: Path, base: str) -> tuple[list[str], dict]:
    if not re.fullmatch(r"[0-9a-fA-F]{40}", base):
        raise ValueError("--base must be an explicit full Git commit SHA")
    base = git(root, "rev-parse", "--verify", f"{base}^{{commit}}").decode().strip()
    candidate = load_policy(json.loads(after(root, POLICY)))
    previous = before(root, base, POLICY)
    # The proposed policy cannot remove a boundary from its own diff. Bootstrap
    # uses the candidate once; after merge the base policy always governs changes.
    policy = load_policy(json.loads(previous)) if previous is not None else candidate
    changed = changed_paths(root, base)
    protected = {p: layers_for(p, policy) for p in sorted(changed) if layers_for(p, policy)}
    errors = pins(root, base)
    for path in changed:
        if layers_for(path, candidate) and any(fnmatch.fnmatchcase(path, p) for p in candidate["flexible"]):
            errors.append(f"ambiguous protected/flexible path: {path}")
    covered = set()
    used_records = []
    for path in sorted(changed):
        if not path.startswith(RECORDS) or not path.endswith(".json") or after(root, path) is None:
            continue
        try:
            record = json.loads(after(root, path))
            if not isinstance(record, dict) or set(record) != {"schema", "kind", "reason", "compatibility", "paths", "regressions"} or record["schema"] != 1:
                raise ValueError("invalid record fields/schema")
            if record["kind"] not in {"bugfix", "compatible-addition"}:
                raise ValueError("freeze allows only bugfix or compatible-addition, not redesign/breaking changes")
            if any(not isinstance(record[k], str) or len(record[k].strip()) < 20 for k in ("reason", "compatibility")):
                raise ValueError("record must explain the reason and preserved compatibility")
            paths = record["paths"]
            regressions = record["regressions"]
            if not isinstance(paths, dict) or not paths or not isinstance(regressions, list) or not set(regressions) <= GROUPS:
                raise ValueError("invalid paths/regressions")
            required = set()
            for target, hashes in paths.items():
                if not relative(target) or any(c in target for c in "*?[") or target not in protected:
                    raise ValueError(f"record target is not an exact changed protected path: {target}")
                if not isinstance(hashes, dict) or set(hashes) != {"before", "after"}:
                    raise ValueError(f"invalid content binding: {target}")
                expected = {"before": digest(before(root, base, target)), "after": digest(after(root, target))}
                if hashes != expected:
                    raise ValueError(f"stale content binding: {target}; regenerate the record after edits/rebase")
                required.update(group for row in protected[target] for group in row["regressions"])
            if not required <= set(regressions):
                raise ValueError("missing regression groups: " + ", ".join(sorted(required - set(regressions))))
            covered.update(paths)
            used_records.append(path)
        except (ValueError, TypeError, KeyError) as error:
            errors.append(f"{path}: {error}")
    for path in sorted(set(protected) - covered):
        errors.append(f"{path}: frozen boundary requires a content-bound compatibility record ({', '.join(r['id'] for r in protected[path])})")
    return errors, {"base": base, "bootstrap": previous is None, "protected": sorted(protected), "records": used_records,
                    "flexible_changes": sorted(p for p in changed if any(fnmatch.fnmatchcase(p, pattern) for pattern in policy["flexible"]))}


def run(root: Path, base: str | None = None) -> int:
    try:
        load_policy(json.loads(after(root, POLICY)))
        if base is None:
            try:
                base = git(root, "merge-base", "HEAD", "origin/master").decode().strip()
            except subprocess.CalledProcessError:
                try:
                    base = git(root, "rev-parse", "HEAD").decode().strip()
                except subprocess.CalledProcessError:
                    print("freeze policy validated only; no Git metadata, so differential checks were NOT run")
                    return 0
        errors, report = check(root, base)
        print("architecture freeze: " + json.dumps(report, sort_keys=True))
        if errors:
            for error in errors:
                print(f"- {error}")
            return 1
        print("stabilization freeze passed; tool handlers and schemas remain flexible")
        return 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.CalledProcessError) as error:
        print(f"architecture freeze failed: {error}")
        return 1


def write_record(root: Path, base: str, name: str, kind: str, reason: str, compatibility: str) -> Path | None:
    """Prepare a plan, never waive hard pins or run commands from its contents."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", name):
        raise ValueError("record name must be lowercase words/digits separated by hyphens")
    if kind not in {"bugfix", "compatible-addition"} or min(len(reason.strip()), len(compatibility.strip())) < 20:
        raise ValueError("explain the bugfix/compatible addition and compatibility (at least 20 characters each)")
    # check() validates the explicit base and reads its governing policy. Missing
    # records are expected here; hard checks are still enforced by the next run.
    _, report = check(root, base)
    paths = report["protected"]
    if not paths:
        return None
    old = before(root, base, POLICY)
    policy = load_policy(json.loads(old if old is not None else after(root, POLICY)))
    groups = sorted({g for p in paths for row in layers_for(p, policy) for g in row["regressions"]})
    record = {"schema":1,"kind":kind,"reason":reason,"compatibility":compatibility,
              "paths":{p:{"before":digest(before(root,base,p)),"after":digest(after(root,p))} for p in paths},
              "regressions":groups}
    file = root / RECORDS / (name + ".json")
    if file.is_symlink():
        raise ValueError("record must not be a symlink")
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(record,indent=2) + "\n",encoding="utf-8",newline="\n")
    return file


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="Full comparison commit SHA")
    parser.add_argument("--record", help="Generate/update a named content-bound record")
    parser.add_argument("--kind", choices=["bugfix","compatible-addition"], default="bugfix")
    parser.add_argument("--reason", default="")
    parser.add_argument("--compatibility", default="")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    if args.record:
        try:
            file = write_record(root,args.base,args.record,args.kind,args.reason,args.compatibility)
            print(f"Prepared {file}; review it and run CI. No tests or approval are implied." if file else "No frozen foundation changed; no record needed.")
        except (OSError,ValueError,TypeError,KeyError,subprocess.CalledProcessError) as error:
            parser.exit(1,f"Cannot prepare freeze record: {error}\n")
    else:
        raise SystemExit(run(root,args.base))
