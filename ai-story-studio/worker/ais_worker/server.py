"""Standard-library HTTP server for the worker (no third-party dependencies).

Used when FastAPI/uvicorn are not installed, and by the test-suite. Behaviour
is identical to the FastAPI adapter because both delegate to ``WorkerAPI``.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from .api import Response, WorkerAPI
from .config import ConfigError, WorkerConfig
from .pod_guard import PodGuard

log = logging.getLogger("ais_worker.server")


def make_handler(api: WorkerAPI) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "ais-worker"
        sys_version = ""

        def _dispatch(self, method: str) -> None:
            length = int(self.headers.get("content-length") or 0)
            if length > api.config.max_upload_bytes * 2:
                # Reject before reading the body; the connection is closed afterwards.
                self.close_connection = True
                self._send(Response(413, {"error": {"code": "FORBIDDEN", "message": "request body too large"}}))
                return
            body = self.rfile.read(length) if length else b""
            headers = {k.lower(): v for k, v in self.headers.items()}
            self._send(api.handle(method, urlsplit(self.path).path, headers, body))

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_POST(self) -> None:
            self._dispatch("POST")

        def _send(self, res: Response) -> None:
            self.send_response(res.status)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            if res.file is not None:
                data = res.file.read_bytes()
                self.send_header("Content-Type", res.mime)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            payload = json.dumps(res.body or {}).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            # Never log headers (they carry the bearer token); method + path only.
            log.info("%s %s", self.command, urlsplit(self.path).path)

    return Handler


def serve(config: WorkerConfig) -> None:
    api = WorkerAPI(config)
    guard = PodGuard.from_env(os.environ)
    if guard:
        api.on_activity = guard.touch
        guard.start()
        log.info("pod guard active (idle %s s, lifetime %s s)", guard.idle_s, guard.max_lifetime_s)
    httpd = ThreadingHTTPServer((config.host, config.port), make_handler(api))
    log.info("AI Story Studio worker on http://%s:%s (mock models: %s)", config.host, httpd.server_port, config.mock_models)

    def stop(*_: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        api.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        config = WorkerConfig.from_env()
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
    serve(config)


if __name__ == "__main__":
    main()
