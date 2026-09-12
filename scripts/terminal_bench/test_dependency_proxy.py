import unittest
from unittest.mock import patch
import socket
import tempfile
from pathlib import Path
from dependency_proxy import public_address, destination, DependencyProxy


class DependencyProxyTests(unittest.TestCase):
    def test_only_exact_public_dependency_hosts(self):
        self.assertEqual(destination('pypi.org:443', True), ('pypi.org', 443, ''))
        self.assertEqual(destination('http://deb.debian.org/debian/', False), ('deb.debian.org', 80, '/debian/'))
        for value in ('localhost:443', '127.0.0.1:443', 'pypi.org.evil.test:443',
                      'api.deepseek.com:443', 'pypi.org:22', 'user@pypi.org:443'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                destination(value, True)

    def test_no_private_or_rebound_dns(self):
        for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1'):
            with patch('dependency_proxy.socket.getaddrinfo', return_value=[(2, 1, 6, '', (address, 443))]):
                with self.assertRaises(ValueError):
                    public_address('pypi.org', 443)

    def test_connection_uses_verified_ip(self):
        with patch('dependency_proxy.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('151.101.0.223', 443))]):
            self.assertEqual(public_address('pypi.org', 443), ('151.101.0.223', 443))

    def test_deny_ambiguous_http_urls(self):
        for value in ('https://pypi.org/', 'http://user@pypi.org/', 'http://pypi.org:123/', 'http://pypi.org/#x'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                destination(value, False)

    @unittest.skipUnless(hasattr(socket, 'AF_UNIX') and __import__('os').name != 'nt', 'Unix proxy integration')
    def test_header_connections_are_bounded_before_thread_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            proxy = DependencyProxy(Path(directory) / 'deps.sock')
            clients = []
            try:
                # Hold every handler slot without sending HTTP headers.
                for _ in range(32):
                    self.assertTrue(proxy.handler_slots.acquire(blocking=False))
                client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                clients.append(client)
                client.settimeout(2)
                client.connect(str(Path(directory) / 'deps.sock'))
                self.assertEqual(client.recv(1), b'')
            finally:
                for client in clients:
                    client.close()
                proxy.stop()
