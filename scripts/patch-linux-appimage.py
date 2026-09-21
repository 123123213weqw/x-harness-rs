#!/usr/bin/env python3
"""Remove ABI-sensitive desktop stack libraries from a Tauri AppImage.

Tauri 2.11/linuxdeploy bundles Ubuntu-22.04 Wayland/GLib infrastructure ahead
of the host libraries.  On Mesa 25+/GLib 2.88 that makes WebKitWebProcess abort
with EGL_BAD_PARAMETER or load incompatible host GIO modules.  These libraries
are platform infrastructure and must be supplied as one coherent set by the
target desktop, while XHarness continues to bundle WebKitGTK itself.

The AppImage runtime prefix is preserved byte-for-byte.  The squashfs payload is
rebuilt in place and any now-stale updater signature is removed deliberately;
release CI must sign the final bytes again before collection.
"""
from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path


# Keep this closed and auditable. Do not grow it to arbitrary libraries merely
# to reduce package size.
INFRASTRUCTURE_GLOBS = (
    "libwayland-*.so*",
    "libxkbcommon.so*",
    "libxcb-*.so*",
    "libXau.so*",
    "libXdmcp.so*",
    "libglib-2.0.so*",
    "libgio-2.0.so*",
    "libgobject-2.0.so*",
    "libgmodule-2.0.so*",
    "libgst*.so*",
    "libmount.so*",
    "libblkid.so*",
    "libselinux.so*",
    "libpcre2-8.so*",
    "libzstd.so*",
    "libelf.so*",
    "libffi.so*",
    # Host GIO's libcurl module must not resolve against the old bundled nghttp2.
    "libnghttp2.so*",
)

ENV_GUARD = """
# XHarness: use one coherent host GLib/GIO/GStreamer stack.  linuxdeploy's
# bundled path is intentionally removed above and an empty GStreamer override
# must not hide the host's plugins.
unset GIO_EXTRA_MODULES
unset GST_PLUGIN_SYSTEM_PATH GST_PLUGIN_SYSTEM_PATH_1_0
""".lstrip()


def patch_appdir(appdir: Path) -> list[str]:
    if not (appdir / "AppRun").exists():
        raise ValueError(f"not an AppDir: {appdir}")
    removed: list[str] = []
    seen: set[Path] = set()
    library_roots = (appdir / "usr/lib", appdir / "usr/lib64")
    for root in library_roots:
        if not root.is_dir():
            continue
        for pattern in INFRASTRUCTURE_GLOBS:
            for path in root.rglob(pattern):
                if path in seen or not (path.is_file() or path.is_symlink()):
                    continue
                seen.add(path)
                path.unlink()
                removed.append(str(path.relative_to(appdir)))

    hooks = appdir / "apprun-hooks/linuxdeploy-plugin-gtk.sh"
    if not hooks.is_file():
        raise ValueError("linuxdeploy GTK AppRun hook is missing")
    text = hooks.read_text(encoding="utf-8")
    marker = "# XHarness: use one coherent host GLib/GIO/GStreamer stack."
    if marker not in text:
        hooks.write_text(text.rstrip() + "\n\n" + ENV_GUARD, encoding="utf-8")

    remaining = []
    for root in library_roots:
        if root.is_dir():
            for pattern in INFRASTRUCTURE_GLOBS:
                remaining.extend(str(path.relative_to(appdir)) for path in root.rglob(pattern))
    if remaining:
        raise RuntimeError(f"ABI-sensitive libraries remain: {remaining}")
    return sorted(removed)


def run(*args: object, capture: bool = False) -> str:
    result = subprocess.run(
        [str(arg) for arg in args],
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def patch_image(image: Path) -> list[str]:
    image = image.resolve()
    if not image.is_file():
        raise ValueError(f"AppImage does not exist: {image}")
    for command in ("unsquashfs", "mksquashfs"):
        if shutil.which(command) is None:
            raise RuntimeError(f"{command} is required (install squashfs-tools)")

    offset = int(run(image, "--appimage-offset", capture=True))
    if offset <= 0 or offset >= image.stat().st_size:
        raise RuntimeError("invalid AppImage squashfs offset")
    with image.open("rb") as source:
        runtime = source.read(offset)
    if len(runtime) != offset:
        raise RuntimeError("truncated AppImage runtime")
    mode = stat.S_IMODE(image.stat().st_mode)
    with tempfile.TemporaryDirectory(prefix="xh-appimage-") as temporary:
        temporary = Path(temporary)
        appdir = temporary / "AppDir"
        payload = temporary / "payload.squashfs"
        run("unsquashfs", "-quiet", "-offset", offset, "-d", appdir, image)
        removed = patch_appdir(appdir)
        run(
            "mksquashfs",
            appdir,
            payload,
            "-noappend",
            "-all-root",
            "-comp",
            "zstd",
            "-quiet",
        )
        replacement = temporary / image.name
        with replacement.open("wb") as output:
            output.write(runtime)
            with payload.open("rb") as source:
                shutil.copyfileobj(source, output)
        replacement.chmod(mode | stat.S_IXUSR)
        # Prove the reconstructed offset can be read before replacing the only
        # release candidate.
        if int(run(replacement, "--appimage-offset", capture=True)) != offset:
            raise RuntimeError("repacked AppImage changed its runtime offset")
        os.replace(replacement, image)

    signature = Path(str(image) + ".sig")
    signature.unlink(missing_ok=True)
    return removed


def main() -> None:
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--appimage", type=Path)
    target.add_argument("--appdir", type=Path)
    args = parser.parse_args()
    removed = patch_image(args.appimage) if args.appimage else patch_appdir(args.appdir.resolve())
    print(f"AppImage compatibility patch removed {len(removed)} ABI-sensitive entries")
    for name in removed:
        print(name)


if __name__ == "__main__":
    main()
