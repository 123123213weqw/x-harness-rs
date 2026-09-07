#!/usr/bin/env python3
"""远程同步回归：根目录构建产物不上传，但必须上传产品 ui/dist。"""
import pathlib
import re
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class RemoteSyncContract(unittest.TestCase):
    def test_scripts_preserve_ui_and_exclude_build_outputs_and_secrets(self):
        for name in ("remote-rust-test.sh", "remote-build-deb.sh"):
            with self.subTest(script=name), tempfile.TemporaryDirectory() as tmp:
                source = ROOT.joinpath("scripts", name).read_text()
                excludes = re.findall(r"--exclude='([^']+)'", source)
                self.assertIn("/dist/", excludes)
                self.assertNotIn("dist/", excludes)
                src, dst = pathlib.Path(tmp, "src"), pathlib.Path(tmp, "dst")
                src.mkdir()
                dst.mkdir()
                files = {
                    "ui/dist/index.html": "current product UI",
                    "ui/dist/plugins/client.js": "current plugin",
                    "ui/overrides/model-controls.js": "product source",
                    "dist/private-build.log": "not for upload",
                    "target/debug/app": "not for upload",
                    "node_modules/dependency": "not for upload",
                    ".git/config": "not for upload",
                    ".env": "not for upload",
                    ".env.production": "not for upload",
                }
                for path, text in files.items():
                    file = src / path
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_text(text)
                subprocess.run(
                    ["rsync", "-a", "--delete"]
                    + ["--exclude=" + pattern for pattern in excludes]
                    + [str(src) + "/", str(dst) + "/"],
                    check=True,
                )
                for path, text in files.items():
                    if path.startswith("ui/"):
                        self.assertEqual((dst / path).read_text(), text)
                    else:
                        self.assertFalse((dst / path).exists(), path)


if __name__ == "__main__":
    unittest.main()
