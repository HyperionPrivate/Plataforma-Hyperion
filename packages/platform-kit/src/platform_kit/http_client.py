from __future__ import annotations

from typing import Any

import httpx

from platform_kit.correlation import get_correlation_id


class BaseHttpClient:
    """HTTP client with timeouts — no retries that are unsafe by default."""

    def __init__(
        self,
        *,
        base_url: str = "",
        timeout_seconds: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(timeout_seconds),
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}) or {})
        cid = get_correlation_id()
        if cid:
            headers.setdefault("X-Correlation-ID", cid)
            headers.setdefault(
                "traceparent", f"00-{cid.replace('-', '')[:32].ljust(32, '0')}-{'0' * 16}-01"
            )
        return await self._client.request(method, url, headers=headers, **kwargs)
