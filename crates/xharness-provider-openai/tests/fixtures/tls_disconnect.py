"""Isolated TLS fault fixture: deliberately omit close_notify, never alter host networking."""
import json
import os
import socket
import ssl
import sys

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen()
print(listener.getsockname()[1], flush=True)
mode = sys.argv[3]
for attempt in range(3):
    raw, _ = listener.accept()
    conn = context.wrap_socket(raw, server_side=True)
    conn.settimeout(4)
    request = b""
    while b"\r\n\r\n" not in request:
        request += conn.recv(4096)
    head, body = request.split(b"\r\n\r\n", 1)
    size = next((int(line.split(b":", 1)[1]) for line in head.lower().split(b"\r\n") if line.startswith(b"content-length:")), 0)
    while len(body) < size:
        body += conn.recv(4096)
    def frame(delta, finish=None):
        return "data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": finish}]}) + "\n\n"
    text = ""
    if attempt > 0 or mode == "completed":
        text = frame({"content": "recovered"}, "stop") + "data: [DONE]\n\n"
    elif mode == "partial":
        text = frame({"content": "partial"})
    # Deliberately no Content-Length: rustls detects EOF without close_notify.
    conn.sendall(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n" + text).encode())
    fd = conn.detach()
    os.close(fd)
