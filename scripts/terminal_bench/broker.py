"""Local, bounded DeepSeek credential broker for disposable benchmark containers.

Bind only to host loopback and a dedicated Unix socket. Real credentials stay in this
process. Per-trial bearer capabilities expire at close/deadline and grant only
bounded chat completions to one fixed model/HTTPS endpoint, never general proxying.
"""
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
from socketserver import ThreadingMixIn
import threading
import time

MAX_BODY = 512 * 1024
MAX_OUTPUT = 4096
INPUT_RATE = 0.30 / 1_000_000  # Peak cache-miss USD; snapshot 2026-09-11.
OUTPUT_RATE = 1.20 / 1_000_000


class BudgetError(Exception):
    pass


class Ledger:
    def __init__(self, dollars=0.30, calls=40, seconds=300):
        self.token = secrets.token_urlsafe(32)
        self.deadline = time.monotonic() + seconds
        self.limit = dollars
        self.max_calls = calls
        self.spent = 0.0
        self.calls = 0
        self.active = True
        self.rows = []
        self.lock = threading.Lock()

    def reserve(self, token, request_bytes):
        # UTF-8 request bytes plus generous protocol overhead are a conservative
        # reservation, not an exact tokenizer/billing measurement.
        amount = (request_bytes + 8192) * INPUT_RATE + MAX_OUTPUT * OUTPUT_RATE
        with self.lock:
            if not self.active or time.monotonic() >= self.deadline or not hmac.compare_digest(token, self.token):
                raise PermissionError("invalid or expired trial capability")
            if self.calls >= self.max_calls or self.spent + amount > self.limit:
                raise BudgetError("trial budget exhausted")
            self.spent += amount
            self.calls += 1
            return amount

    def settle(self, reserved, usage, status, elapsed):
        with self.lock:
            # Charge all input at peak cache-miss rates for a conservative cap.
            # Missing usage/failure keeps the full reservation; never free-retry.
            billed_bound = reserved
            if usage is not None:
                billed_bound = (usage.get("prompt_tokens", 0) * INPUT_RATE
                                + usage.get("completion_tokens", 0) * OUTPUT_RATE)
                self.spent += billed_bound - reserved
                if billed_bound > reserved:
                    self.active = False  # Unexpected tokenizer/accounting: fail closed.
            self.rows.append({"status": status, "usage": usage, "seconds": elapsed,
                              "reserved_usd": reserved, "conservative_usd": billed_bound})

    def close(self):
        with self.lock:
            self.active = False
            return {"requests": self.calls, "conservative_usd": self.spent,
                    "limit_usd": self.limit, "rows": list(self.rows)}


def normalize(body):
    if body.get("model") not in ("deepseek-flash", "openai/deepseek-flash"):
        raise ValueError("model not permitted")
    if not isinstance(body.get("messages"), list):
        raise ValueError("messages required")
    result = dict(body)
    result["model"] = "deepseek-flash"
    result["max_tokens"] = MAX_OUTPUT
    result["n"] = 1
    result.pop("max_completion_tokens", None)
    # Fix model-side settings for both harnesses; no hidden effort advantage.
    result["thinking"] = {"type": "enabled"}
    result["reasoning_effort"] = "high"
    if result.get("stream"):
        result["stream_options"] = {"include_usage": True}
    return result


class Broker:
    def __init__(self, api_key, bind, unix_path=None):
        if unix_path is not None:
            from socketserver import UnixStreamServer
        self.api_key = api_key
        self.ledger = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass  # Never log bearer headers or request content.

            def error(self, code, message):
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": {"message": message, "type": "benchmark_broker"}}).encode())

            def do_POST(self):
                if self.path not in ("/chat/completions", "/v1/chat/completions"):
                    return self.error(404, "endpoint not permitted")
                ledger = owner.ledger
                if ledger is None:
                    return self.error(403, "no active trial")
                self.connection.settimeout(120)
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= MAX_BODY or self.headers.get("Transfer-Encoding"):
                        raise ValueError("invalid request size")
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise ValueError("incomplete body")
                    body = normalize(json.loads(raw))
                    encoded = json.dumps(body, ensure_ascii=False).encode()
                    token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                    reserved = ledger.reserve(token, len(encoded))
                except PermissionError:
                    return self.error(403, "invalid trial capability")
                except BudgetError:
                    return self.error(402, "trial budget exhausted")
                except (ValueError, TypeError, AttributeError):
                    return self.error(400, "invalid request")
                usage = None
                status = "transport_error"
                started = time.monotonic()
                upstream = http.client.HTTPSConnection("api.deepseek.com", timeout=120)
                try:
                    upstream.request("POST", "/chat/completions", encoded,
                                     {"Authorization": "Bearer " + owner.api_key, "Content-Type": "application/json"})
                    response = upstream.getresponse()
                    status = response.status
                    if status != 200:
                        # Do not forward arbitrary upstream error text or redirects.
                        return self.error(status if 400 <= status < 600 else 502, "upstream request failed")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
                    self.end_headers()
                    if body.get("stream"):
                        while True:
                            line = response.readline(MAX_BODY + 1)
                            if not line:
                                break
                            if len(line) > MAX_BODY:
                                raise ValueError("oversized upstream event")
                            if line.startswith(b"data: ") and line.strip() != b"data: [DONE]":
                                item = json.loads(line[6:])
                                if item.get("usage") is not None:
                                    usage = item["usage"]
                            self.wfile.write(line)
                            self.wfile.flush()
                    else:
                        data = response.read(2 * MAX_BODY + 1)
                        if len(data) > 2 * MAX_BODY:
                            raise ValueError("oversized upstream response")
                        usage = json.loads(data).get("usage")
                        self.wfile.write(data)
                except (OSError, ValueError, http.client.HTTPException):
                    status = "transport_error"
                finally:
                    upstream.close()
                    ledger.settle(reserved, usage, status, time.monotonic() - started)

        self.server = ThreadingHTTPServer((bind, 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.unix_server = None
        self.unix_thread = None
        if unix_path is not None:
            class UnixHttpServer(ThreadingMixIn, UnixStreamServer):
                daemon_threads = True
            self.unix_server = UnixHttpServer(str(unix_path), Handler)
            self.unix_thread = threading.Thread(target=self.unix_server.serve_forever, daemon=True)
            self.unix_thread.start()

    @property
    def url(self):
        host, port = self.server.server_address
        return f"http://{host}:{port}/v1"

    def stop(self):
        if self.ledger:
            self.ledger.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        if self.unix_server:
            self.unix_server.shutdown()
            self.unix_server.server_close()
            self.unix_thread.join(timeout=5)
