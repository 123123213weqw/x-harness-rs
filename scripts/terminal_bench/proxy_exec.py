"""Run one disposable-container command with the private dependency proxy."""
import os
import subprocess
import sys
from relay import Relay


def main():
    relay = Relay('/opt/benchmark-dependencies/deps.sock')
    try:
        env = dict(os.environ)
        proxy = relay.url.removesuffix('/v1')
        env.update(http_proxy=proxy, https_proxy=proxy, HTTP_PROXY=proxy, HTTPS_PROXY=proxy,
                   no_proxy='127.0.0.1,localhost', NO_PROXY='127.0.0.1,localhost',
                   PIP_INDEX_URL='https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple',
                   UV_INDEX_URL='https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple',
                   # Supported by the task's exact uv 0.9.5 installer. The
                   # official Astral CDN serves the same versioned artifacts.
                   UV_DOWNLOAD_URL='https://releases.astral.sh/github/uv/releases/download/0.9.5')
        return subprocess.run(sys.argv[1:], env=env).returncode
    finally:
        relay.stop()


if __name__ == '__main__':
    sys.exit(main())
