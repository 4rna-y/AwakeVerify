from __future__ import annotations

import threading
import time
from typing import Any, Protocol


class WorkerAuthenticationError(RuntimeError):
    """A worker credential could not be used for a backend request."""


class WorkerAuthProvider(Protocol):
    def authorization_headers(self) -> dict[str, str]: ...


class ApiKeyWorkerAuthProvider:
    def __init__(self, api_key: str | None) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("WORKER_API_KEY is required for api_key authentication")
        self._api_key = api_key

    def authorization_headers(self) -> dict[str, str]:
        return {"X-Worker-Api-Key": self._api_key}


class EntraWorkerAuthProvider:
    """Gets a backend API token through managed/workload identity credentials.

    DefaultAzureCredential supports Azure Managed Identity in production and
    workload-identity federation when the corresponding environment variables are
    supplied. The token is cached in memory only and is never logged or persisted.
    """

    def __init__(
        self,
        scope: str | None,
        *,
        client_id: str | None = None,
        credential: Any | None = None,
    ) -> None:
        if not scope or not scope.strip():
            raise ValueError("WORKER_BACKEND_TOKEN_SCOPE is required for entra_id authentication")
        self._scope = scope.strip()
        self._credential = credential or self._create_default_credential(client_id)
        self._cached_token: str | None = None
        self._cached_expires_at = 0.0
        self._lock = threading.Lock()

    @staticmethod
    def _create_default_credential(client_id: str | None) -> Any:
        try:
            from azure.identity import DefaultAzureCredential
        except ImportError as error:  # pragma: no cover - exercised by packaging/startup
            raise ValueError("azure-identity is required for entra_id authentication") from error
        return DefaultAzureCredential(managed_identity_client_id=client_id or None)

    def authorization_headers(self) -> dict[str, str]:
        now = time.time()
        with self._lock:
            if self._cached_token and now < self._cached_expires_at - 60:
                return {"Authorization": f"Bearer {self._cached_token}"}

            try:
                access_token = self._credential.get_token(self._scope)
                token = str(access_token.token)
                expires_at = float(access_token.expires_on)
            except Exception as error:
                # Token acquisition is a retryable dependency failure while the
                # worker is processing a Service Bus message.
                raise WorkerAuthenticationError("unable to acquire Entra ID worker token") from error

            if not token or expires_at <= now:
                raise WorkerAuthenticationError("Entra ID worker token is empty or expired")
            self._cached_token = token
            self._cached_expires_at = expires_at
            return {"Authorization": f"Bearer {token}"}


def create_worker_auth_provider(
    *,
    mode: str,
    api_key: str | None,
    token_scope: str | None,
    client_id: str | None = None,
) -> WorkerAuthProvider:
    normalized_mode = mode.strip().lower()
    if normalized_mode in {"api_key", "local", "development"}:
        return ApiKeyWorkerAuthProvider(api_key)
    if normalized_mode in {"entra_id", "entra", "production", "managed_identity", "workload_identity"}:
        return EntraWorkerAuthProvider(token_scope, client_id=client_id)
    raise ValueError("WORKER_AUTH_MODE must be api_key or entra_id")
