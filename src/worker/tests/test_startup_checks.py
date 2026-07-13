# pyright: reportUninitializedInstanceVariable=false
from __future__ import annotations

import socket
import tempfile
import threading
from http.client import HTTPResponse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast, override
from unittest import TestCase
from urllib.request import Request, urlopen

from app.main import (
    WorkerConfig,
    check_backend_dependency,
    is_azure_frame_source_enabled,
    start_health_server,
    validate_config,
)


class StartupCheckHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health-ok":
            self.send_response(200)
        elif self.path == "/health-fail":
            self.send_response(503)
        else:
            self.send_response(404)
        self.end_headers()

    @override
    def log_message(self, format: str, *args: object) -> None:
        _ = format
        _ = args


class StartupChecksTests(TestCase):
    server: ThreadingHTTPServer
    thread: threading.Thread
    base_url: str

    @override
    def setUp(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), StartupCheckHandler)
        _, port = cast(tuple[str, int], self.server.server_address)
        self.base_url = f"http://127.0.0.1:{port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @override
    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)

    def test_backend_base_url_404_is_reachable_without_health_url(self) -> None:
        result = check_backend_dependency(
            base_url=self.base_url,
            health_url=None,
            timeout_seconds=1,
        )

        self.assertTrue(result.reachable)
        self.assertIn("HTTP 404", result.detail)

    def test_backend_health_url_requires_successful_status(self) -> None:
        result = check_backend_dependency(
            base_url=self.base_url,
            health_url=f"{self.base_url}/health-fail",
            timeout_seconds=1,
        )

        self.assertFalse(result.reachable)
        self.assertIn("HTTP 503", result.detail)

    def test_backend_health_url_accepts_successful_status(self) -> None:
        result = check_backend_dependency(
            base_url=self.base_url,
            health_url=f"{self.base_url}/health-ok",
            timeout_seconds=1,
        )

        self.assertTrue(result.reachable)
        self.assertIn("HTTP 200", result.detail)

    def test_validate_config_rejects_missing_azure_settings_instead_of_local_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            model_path = Path(temp_dir) / "model.task"
            _ = model_path.write_bytes(b"model")
            config = WorkerConfig(
                model_path=model_path,
                backend_base_url=self.base_url,
                backend_health_url=None,
                poll_interval_seconds=0.2,
                post_timeout_seconds=3.0,
                startup_check_timeout_seconds=3.0,
                health_host="0.0.0.0",
                health_port=8000,
                service_bus_connection_string=None,
                service_bus_queue_name=None,
                blob_connection_string=None,
                blob_container_name="frames",
            )

            with self.assertRaises(SystemExit) as context:
                validate_config(config)

            self.assertIn("local fallback is disabled", str(context.exception))
            self.assertIn("SERVICEBUS_CONNECTION_STRING", str(context.exception))
            self.assertIn("BLOB_CONNECTION_STRING", str(context.exception))

    def test_worker_health_endpoint_allows_browser_cors_checks(self) -> None:
        port = find_free_port()
        server = start_health_server("127.0.0.1", port)
        self.assertIsNotNone(server)
        try:
            request = Request(f"http://127.0.0.1:{port}/health")
            request.add_header("Origin", "http://localhost:3000")
            with cast(HTTPResponse, urlopen(request, timeout=1)) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()

    def test_worker_health_endpoint_allows_browser_preflight(self) -> None:
        port = find_free_port()
        server = start_health_server("127.0.0.1", port)
        self.assertIsNotNone(server)
        try:
            request = Request(f"http://127.0.0.1:{port}/health", method="OPTIONS")
            request.add_header("Origin", "http://localhost:3000")
            request.add_header("Access-Control-Request-Method", "GET")
            with cast(HTTPResponse, urlopen(request, timeout=1)) as response:
                self.assertEqual(response.status, 204)
                self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
                self.assertIn("GET", response.headers["Access-Control-Allow-Methods"])
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()

    def test_azure_frame_source_requires_all_connection_settings(self) -> None:
        config = WorkerConfig(
            model_path=Path("model.task"),
            backend_base_url=self.base_url,
            backend_health_url=None,
            poll_interval_seconds=0.2,
            post_timeout_seconds=3.0,
            startup_check_timeout_seconds=3.0,
            health_host="0.0.0.0",
            health_port=8000,
            service_bus_connection_string="Endpoint=sb://example/;SharedAccessKeyName=name;SharedAccessKey=key",
            service_bus_queue_name=None,
            blob_connection_string="UseDevelopmentStorage=true",
            blob_container_name="frames",
        )

        self.assertFalse(is_azure_frame_source_enabled(config))

        enabled_config = WorkerConfig(
            model_path=Path("model.task"),
            backend_base_url=self.base_url,
            backend_health_url=None,
            poll_interval_seconds=0.2,
            post_timeout_seconds=3.0,
            startup_check_timeout_seconds=3.0,
            health_host="0.0.0.0",
            health_port=8000,
            service_bus_connection_string=config.service_bus_connection_string,
            service_bus_queue_name="frame-processing-queue",
            blob_connection_string=config.blob_connection_string,
            blob_container_name="frames",
        )

        self.assertTrue(is_azure_frame_source_enabled(enabled_config))


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return cast(tuple[str, int], probe.getsockname())[1]
