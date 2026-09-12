"""Container-loopback TCP to the single mounted broker Unix socket; no shell."""
import select
import socket
from socketserver import BaseRequestHandler, ThreadingTCPServer
import threading


class Relay:
    def __init__(self, path="/opt/benchmark-broker/api.sock"):
        class Handler(BaseRequestHandler):
            def handle(self):
                try:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as upstream:
                        upstream.settimeout(120)
                        upstream.connect(path)
                        while True:
                            ready, _, _ = select.select([self.request, upstream], [], [], 120)
                            if not ready:
                                return
                            for source in ready:
                                data = source.recv(65536)
                                if not data:
                                    return
                                target = upstream if source is self.request else self.request
                                target.sendall(data)
                except OSError:
                    return

        self.server = ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
