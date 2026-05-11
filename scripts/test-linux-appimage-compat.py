#!/usr/bin/env python3
import importlib.util
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("patch_linux_appimage", ROOT / "scripts/patch-linux-appimage.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


with tempfile.TemporaryDirectory(prefix="xh-appdir-test-") as temporary:
    appdir = Path(temporary)
    (appdir / "AppRun").write_text("#!/bin/sh\n")
    hook = appdir / "apprun-hooks/linuxdeploy-plugin-gtk.sh"
    hook.parent.mkdir()
    hook.write_text('export GIO_EXTRA_MODULES="$APPDIR/usr/lib/gio/modules"\n')
    library = appdir / "usr/lib/x86_64-linux-gnu"
    library.mkdir(parents=True)
    for name in (
        "libwayland-client.so.0",
        "libglib-2.0.so.0",
        "libgstreamer-1.0.so.0",
        "libnghttp2.so.14",
        "libwebkit2gtk-4.1.so.0",
    ):
        (library / name).write_bytes(b"fixture")
    removed = module.patch_appdir(appdir)
    assert len(removed) == 4, removed
    assert (library / "libwebkit2gtk-4.1.so.0").is_file()
    assert not (library / "libwayland-client.so.0").exists()
    patched = hook.read_text()
    assert "unset GIO_EXTRA_MODULES" in patched
    assert "unset GST_PLUGIN_SYSTEM_PATH GST_PLUGIN_SYSTEM_PATH_1_0" in patched
    # Reapplying is safe and does not duplicate the environment guard.
    assert module.patch_appdir(appdir) == []
    assert hook.read_text().count("# XHarness: use one coherent") == 1

print("Linux AppImage compatibility patch is closed, selective and idempotent.")
