"""Small local gateway for serving MD Store and proxying API calls.

Run from the project root with the backend virtualenv Python:
    ..\mdstore-backend\.venv\Scripts\python.exe mdstore_gateway.py

It binds only to loopback. The existing backend (8000) and storefront (5500)
remain unchanged; ngrok can point the single public domain at port 8080.
"""

from __future__ import annotations

import http.client
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent
FRONTEND_ROOT = (ROOT / "MD Store").resolve()
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8000
GATEWAY_HOST = "127.0.0.1"
GATEWAY_PORT = 8080
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        # Avoid logging query strings such as Paymob's callback HMAC.
        return

    def do_GET(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._proxy_to_backend()

    def do_PUT(self) -> None:
        self._proxy_to_backend()

    def do_PATCH(self) -> None:
        self._proxy_to_backend()

    def do_DELETE(self) -> None:
        self._proxy_to_backend()

    def do_OPTIONS(self) -> None:
        self._proxy_to_backend()

    def _dispatch(self) -> None:
        static_file = self._static_file()
        if static_file is None:
            self._proxy_to_backend()
            return
        try:
            content = static_file.read_bytes()
        except OSError:
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(str(static_file))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def _static_file(self) -> Path | None:
        path = unquote(urlsplit(self.path).path)
        if path in ("", "/"):
            path = "/MD.html"
        candidate = (FRONTEND_ROOT / path.lstrip("/")).resolve()
        try:
            if os.path.commonpath((str(FRONTEND_ROOT), str(candidate))) != str(FRONTEND_ROOT):
                return None
        except ValueError:
            return None
        return candidate if candidate.is_file() else None

    def _proxy_to_backend(self) -> None:
        body = None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0:
                self.send_error(400)
                return
            if length:
                body = self.rfile.read(length)
            headers = {
                key: value
                for key, value in self.headers.items()
                if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "host"
            }
            connection = http.client.HTTPConnection(BACKEND_HOST, BACKEND_PORT, timeout=30)
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            response_body = response.read()
            self.send_response(response.status, response.reason)
            for key, value in response.getheaders():
                if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "content-length":
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            if self.command != "HEAD" and response_body:
                self.wfile.write(response_body)
            connection.close()
        except (OSError, http.client.HTTPException, ValueError):
            if not self.wfile.closed:
                self.send_error(502, "Backend is unavailable")


if __name__ == "__main__":
    server = ThreadingHTTPServer((GATEWAY_HOST, GATEWAY_PORT), GatewayHandler)
    print(f"MD Store gateway: http://{GATEWAY_HOST}:{GATEWAY_PORT}/MD.html")
    print(f"Frontend upstream: {FRONTEND_ROOT}")
    print(f"Backend upstream: http://{BACKEND_HOST}:{BACKEND_PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
