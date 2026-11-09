"""Same-origin browser access without trusting arbitrary forwarded hosts."""
from urllib.parse import urlsplit

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse


def _origin(value):
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            return None
        return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == "https" else 80)
    except (ValueError, AttributeError):
        return None


def same_origin(scope):
    headers = Headers(scope=scope)
    origin = headers.get("origin")
    # Non-browser clients can omit Origin; they still need normal authentication.
    # Fetch Metadata catches cross-site browser requests without an Origin header.
    if not origin:
        return headers.get("sec-fetch-site") not in ("cross-site", "same-site")
    scheme = {"ws": "http", "wss": "https"}.get(scope.get("scheme"), scope.get("scheme"))
    peer = (scope.get("client") or (None,))[0]
    if peer in ("127.0.0.1", "::1"):
        forwarded = headers.get("x-forwarded-proto", "").lower()
        if forwarded in ("http", "https"):
            scheme = forwarded
    source = _origin(origin)
    target = _origin(str(scheme) + "://" + headers.get("host", ""))
    return source is not None and source == target


class BrowserSecurityMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        kind, path = scope["type"], scope.get("path", "")
        if kind not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        guarded = path.startswith(("/api/", "/ws/"))
        if guarded and not same_origin(scope):
            if kind == "websocket":
                return await send({"type": "websocket.close", "code": 4403})
            response = JSONResponse({"detail": "Cross-origin browser access is not allowed"}, status_code=403,
                                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
            return await response(scope, receive, send)

        async def secure_send(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.setdefault("X-Content-Type-Options", "nosniff")
                headers.setdefault("Referrer-Policy", "no-referrer")
                if path.startswith("/api/"):
                    headers["Cache-Control"] = "private, no-store"
                if path in ("/", "/index.html"):
                    headers["X-Frame-Options"] = "DENY"
                    headers["Content-Security-Policy"] = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
            await send(message)

        await self.app(scope, receive, secure_send if kind == "http" else send)
