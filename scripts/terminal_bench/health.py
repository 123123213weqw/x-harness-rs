"""Fail before paid calls if the shared dependency network is unavailable."""
import shlex

# Reachability only: not a claim that dependency installation/grading will pass.
# Do not replace or expose hidden tests, disable TLS, or alter host networking.
PROBE = """import shutil, urllib.request
missing = [tool for tool in ('bash', 'rg', 'tmux', 'ps', 'python3') if not shutil.which(tool)]
if missing:
    raise RuntimeError('prepare the common dependency image; missing: ' + ', '.join(missing))
for url in ('http://deb.debian.org/debian/dists/bookworm/Release',
            'https://astral.sh/uv/0.9.5/install.sh',
            'https://pypi.org/simple/pytest/'):
    with urllib.request.urlopen(url, timeout=5) as response:
        response.read(1)
print('common tools and dependency endpoint preflight passed')
"""


async def check_dependencies(environment):
    # The outer deadline also bounds DNS resolution, which urllib's socket
    # timeout alone does not reliably bound on every platform.
    try:
        result = await environment.exec("python3 -c " + shlex.quote(PROBE), timeout_sec=25)
    except Exception:
        raise RuntimeError("Dependency tools/network preflight failed before model activation") from None
    if result.return_code:
        raise RuntimeError("Dependency tools/network preflight failed before model activation")
