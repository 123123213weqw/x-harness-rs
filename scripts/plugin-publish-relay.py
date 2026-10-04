#!/usr/bin/env python3
"""Forced SSH command: relay only to engine SSH, with no forwarding channels.

Register with `restrict,command="python3 /absolute/path/plugin-publish-relay.py"`.
Do not enable OpenSSH `port-forwarding`: that would also enable Unix sockets.
The final engine key is separately restricted to public plugin publication.
"""
import os
import sys


def main():
    if os.environ.get('SSH_ORIGINAL_COMMAND') != 'forward-engine-plugins v1':
        print('Plugin relay rejected; Shell and arbitrary destinations disabled.', file=sys.stderr)
        return 2
    # Mature system TCP relay handles partial writes, EOF and backpressure.
    # Absolute binary paths, a fixed destination and bounded idle/total times;
    # no user input is interpolated into a Shell, host, port or argument.
    os.execv('/usr/bin/timeout', ['/usr/bin/timeout', '180', '/usr/bin/nc',
                                '-w', '30', '222.186.10.53', '22'])


if __name__ == '__main__':
    sys.exit(main())
