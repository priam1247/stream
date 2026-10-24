from __future__ import annotations

import asyncio
import hashlib
import random
import time
from pathlib import Path

import httpx

from .blockers import CHALLENGE_HINT, ChallengeError, looks_challenged
from .config import BASE_HEADERS, RETRY_STATUS, RETRY_WITH_UA_ROTATION, USER_AGENTS


class RateLimiter:
    """Async token bucket — the fix for the 429 wall."""

    def __init__(self, rate: float = 6.0, burst: int = 6) -> None:
        self.rate = max(rate, 0.1)
        self.capacity = max(burst, 1)
        self._tokens = float(self.capacity)
        self._updated = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self._tokens = min(
                    self.capacity, self._tokens + (now - self._updated) * self.rate
                )
                self._updated = now
                if self._tokens >= 1:
                    self._tokens -= 1
                    return
                await asyncio.sleep((1 - self._tokens) / self.rate)


class DiskCache:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        return self.root / digest[:2] / digest

    def get(self, key: str) -> bytes | None:
        p = self._path(key)
        return p.read_bytes() if p.is_file() else None

    def put(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)


class Fetcher:
    def __init__(
        self,
        *,
        concurrency: int = 6,
        rate: float = 6.0,
        timeout: float = 30.0,
        retries: int = 4,
        cache_dir: str | Path | None = ".scribd-cache",
        cookies: dict[str, str] | None = None,
        proxy: str | None = None,
        rotate_ua: bool = True,
        impersonate: str | None = "chrome",
    ) -> None:
        self.retries = retries
        self.cache = DiskCache(cache_dir) if cache_dir else None
        self.rotate_ua = rotate_ua
        self._limiter = RateLimiter(rate, burst=max(2, concurrency))
        self._sem = asyncio.Semaphore(concurrency)
        self._client: httpx.AsyncClient | None = None
        self._cffi = None
        self._ua = 0
        self._cookies = cookies or {}
        self._proxy = proxy
        self._timeout = timeout
        # Anti-bot bypass: Akamai fingerprints the TLS/HTTP2 handshake, so
        # a perfectly valid cookie jar still gets a "Client Challenge" page
        # from plain httpx. curl_cffi reproduces a real Chrome handshake.
        self.impersonate = impersonate
        self.backend = "httpx"

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = dict(BASE_HEADERS)
        h["User-Agent"] = USER_AGENTS[self._ua % len(USER_AGENTS)]
        if extra:
            h.update(extra)
        return h

    async def __aenter__(self) -> "Fetcher":
        if self.impersonate:
            try:
                from curl_cffi.requests import AsyncSession  # type: ignore
            except Exception:
                self.backend = "httpx (curl_cffi not installed)"
            else:
                kwargs: dict = dict(
                    impersonate=self.impersonate,
                    timeout=self._timeout,
                    cookies=self._cookies,
                    headers=self._headers(),
                    allow_redirects=True,
                )
                if self._proxy:
                    kwargs["proxies"] = {"http": self._proxy, "https": self._proxy}
                self._cffi = AsyncSession(**kwargs)
                self.backend = f"curl_cffi ({self.impersonate})"
                return self

        kwargs = dict(
            timeout=httpx.Timeout(self._timeout),
            follow_redirects=True,
            cookies=self._cookies,
            headers=self._headers(),
        )
        if self._proxy:
            kwargs["proxy"] = self._proxy
        self._client = httpx.AsyncClient(**kwargs)
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._client:
            await self._client.aclose()
        if self._cffi is not None:
            try:
                await self._cffi.close()
            except Exception:
                pass

    async def get(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        use_cache: bool = True,
        allow_status: tuple[int, ...] = (),
    ) -> httpx.Response:
        if use_cache and self.cache:
            cached = self.cache.get(url)
            if cached is not None:
                return httpx.Response(200, content=cached, request=httpx.Request("GET", url))

        assert self._client is not None or self._cffi is not None, (
            "use Fetcher as an async context manager"
        )
        last_exc: Exception | None = None
        challenged = False

        for attempt in range(self.retries + 1):
            delay = 0.0
            async with self._sem:
                await self._limiter.acquire()
                try:
                    hdrs = self._headers(headers)
                    if self._cffi is not None:
                        resp = await self._cffi.get(url, headers=hdrs)
                    else:
                        resp = await self._client.get(url, headers=hdrs)  # type: ignore[union-attr]
                except Exception as exc:  # transport errors, both backends
                    last_exc = exc
                else:
                    if resp.status_code == 200 or resp.status_code in allow_status:
                        body = resp.text or ""
                        ctype = str(resp.headers.get("content-type", "")).lower()
                        # HTTP 200 + "Client Challenge" is a bot-wall, not a
                        # document. Never cache it, never return it as content.
                        if "html" in ctype and looks_challenged(body):
                            challenged = True
                            last_exc = ChallengeError(CHALLENGE_HINT)
                            if self.rotate_ua:
                                self._ua += 1
                            delay = 1.5 * (attempt + 1)
                        else:
                            if use_cache and self.cache and resp.status_code == 200:
                                self.cache.put(url, resp.content)
                            return resp
                    # FIX (vs. original listing): 403 was checked for
                    # UA-rotation inside the RETRY_STATUS branch, but 403
                    # was not in RETRY_STATUS — so that code was dead and
                    # a bot-wall 403 was returned immediately, unretried.
                    if challenged:
                        pass  # already staged for retry above
                    elif resp.status_code in RETRY_STATUS or (
                        resp.status_code in RETRY_WITH_UA_ROTATION
                    ):
                        last_exc = httpx.HTTPStatusError(
                            f"HTTP {resp.status_code}", request=resp.request, response=resp
                        )
                        if resp.status_code in RETRY_WITH_UA_ROTATION:
                            if self.rotate_ua:
                                self._ua += 1
                            ra = resp.headers.get("retry-after")
                            if ra and ra.isdigit():
                                delay = float(ra)
                    else:
                        return resp

            if attempt < self.retries:
                if not delay:
                    delay = min(2**attempt, 15) + random.uniform(0, 0.8)
                await asyncio.sleep(delay)

        raise last_exc or RuntimeError(f"GET failed: {url}")
