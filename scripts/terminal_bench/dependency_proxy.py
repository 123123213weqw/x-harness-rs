"""Private Unix-socket public-dependency proxy; never a host-network escape.

CONNECT preserves end-to-end TLS (and therefore cannot enforce HTTP methods
inside a tunnel). Only exact public artifact hosts on 443, or HTTP GET on 80,
are reachable. No provider API host, private IP, or arbitrary port is allowed.
"""
from http.server import BaseHTTPRequestHandler
import http.client
import ipaddress
import select
import socket
from socketserver import ThreadingMixIn
import threading
import time
from urllib.parse import urlsplit

HOSTS = frozenset({
    'deb.debian.org', 'security.debian.org', 'pypi.org', 'files.pythonhosted.org',
    'astral.sh', 'releases.astral.sh', 'github.com', 'objects.githubusercontent.com',
    'release-assets.githubusercontent.com', 'registry.npmjs.org', 'nodejs.org',
    'mirrors.tuna.tsinghua.edu.cn',
})


def destination(value, tunnel):
    parsed = urlsplit(('https://' if tunnel else '') + value)
    host = parsed.hostname
    port = parsed.port or (443 if tunnel else 80)
    if (host not in HOSTS or parsed.username or parsed.password or parsed.fragment
            or parsed.scheme != ('https' if tunnel else 'http')
            or port != (443 if tunnel else 80)
            or (tunnel and (parsed.path or parsed.query))):
        raise ValueError('dependency destination denied')
    path = (parsed.path or '/') + ('?' + parsed.query if parsed.query else '')
    return host, port, '' if tunnel else path


def public_address(host, port):
    # IPv4 avoids host-specific IPv6 routing failures. Resolve ONCE, validate
    # every answer, then connect to that numeric address (no DNS rebinding).
    rows = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
    addresses = [row[4][0] for row in rows]
    if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
        raise ValueError('non-public dependency address denied')
    return addresses[0], port


class DependencyProxy:
    def __init__(self, path, seconds=1800, byte_limit=2 * 1024**3):
        from socketserver import UnixStreamServer
        owner = self
        self.deadline = time.monotonic() + seconds
        self.byte_limit = byte_limit
        self.bytes = 0
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(16)
        self.handler_slots = threading.BoundedSemaphore(32)
        self.active = True
        self.connections = set()

        class Handler(BaseHTTPRequestHandler):
            rbufsize = 0

            def log_message(self, *args):
                pass

            def setup(self):
                self.request.settimeout(15)
                super().setup()

            def do_CONNECT(self):
                self.forward(True)

            def do_GET(self):
                self.forward(False)

            def forward(self, tunnel):
                if not owner.slots.acquire(blocking=False):
                    return self.send_error(503, 'dependency concurrency limit')
                upstream = None
                try:
                    host, port, path = destination(self.path, tunnel)
                    owner.consume(0)
                    address = public_address(host, port)
                    upstream = socket.create_connection(address, timeout=15)
                    with owner.lock:
                        owner.connections.add(upstream)
                    upstream.settimeout(15)
                    if tunnel:
                        self.send_response(200, 'Connection established')
                        self.end_headers()
                        end = min(owner.deadline, time.monotonic() + 180)
                        while time.monotonic() < end:
                            ready, _, _ = select.select([self.connection, upstream], [], [], 5)
                            owner.consume(0)
                            for source in ready:
                                data = source.recv(65536)
                                if not data:
                                    return
                                owner.consume(len(data))
                                (upstream if source is self.connection else self.connection).sendall(data)
                    else:
                        # No caller headers, credentials, cookies or request bodies
                        # forwarded. Redirect destinations require a new checked request.
                        upstream.sendall((f'GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n').encode('ascii'))
                        response = http.client.HTTPResponse(upstream)
                        response.begin()
                        self.send_response(response.status)
                        for key in ('Content-Type', 'Content-Encoding', 'Location'):
                            value = response.getheader(key)
                            if value:
                                self.send_header(key, value)
                        if response.length is not None:
                            self.send_header('Content-Length', str(response.length))
                        self.send_header('Connection', 'close')
                        self.end_headers()
                        while data := response.read(65536):
                            owner.consume(len(data))
                            self.wfile.write(data)
                except (ValueError, OSError, http.client.HTTPException):
                    # The client gets a closed tunnel or a generic denial, no
                    # internal resolver addresses, credentials or response payloads.
                    if upstream is None:
                        try:
                            self.send_error(403, 'dependency connection denied')
                        except OSError:
                            pass
                finally:
                    if upstream:
                        with owner.lock:
                            owner.connections.discard(upstream)
                        upstream.close()
                    owner.slots.release()

        class Server(ThreadingMixIn, UnixStreamServer):
            daemon_threads = True

            def process_request(self, request, client_address):
                # Bound stalled headers too, before ThreadingMixIn spawns a
                # thread. The forwarding semaphore alone is too late.
                if not owner.handler_slots.acquire(blocking=False):
                    self.shutdown_request(request)
                    return
                try:
                    super().process_request(request, client_address)
                except BaseException:
                    owner.handler_slots.release()
                    raise

            def process_request_thread(self, request, client_address):
                try:
                    super().process_request_thread(request, client_address)
                finally:
                    owner.handler_slots.release()

        self.server = Server(str(path), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def consume(self, count):
        with self.lock:
            if not self.active or time.monotonic() >= self.deadline or self.bytes + count > self.byte_limit:
                raise ValueError('dependency proxy limit reached')
            self.bytes += count

    def stop(self):
        with self.lock:
            self.active = False
            for connection in self.connections:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
