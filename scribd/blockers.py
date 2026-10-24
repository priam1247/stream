"""Detection of anti-bot interstitial pages.

Why this matters: Scribd sits behind Akamai bot protection. When it does
not like a request it still answers **HTTP 200** with a small HTML page
titled "Client Challenge". A naive scraper treats that as the document and
writes a three-line text file that says "A required part of this site
couldn't load" — which is exactly what happened here, and looked like a
success ("1/1 succeeded") while containing no document at all.

Two consequences encoded here:
1. ``looks_challenged()`` is checked on every 200 HTML response, and a
   challenge is treated as a *failure* (retried with a different UA /
   impersonation), never cached and never written out as a document.
2. The usual cause is TLS/HTTP2 fingerprinting: a real browser's handshake
   differs from Python's ``httpx``. ``curl_cffi`` with ``impersonate``
   reproduces a real Chrome fingerprint and is what actually gets past it.
"""

from __future__ import annotations

import re

CHALLENGE_MARKERS = (
    "Client Challenge",
    "A required part of this site couldn",
    "enable JavaScript and cookies to continue",
    "Just a moment...",
    "Attention Required!",
    "cf-challenge",
    "/cdn-cgi/challenge-platform",
    "_Incapsula_Resource",
    "Pardon Our Interruption",
    "px-captcha",
    "Access to this page has been denied",
    "Please verify you are a human",
    "checking your browser before accessing",
)

CHALLENGE_HINT = (
    "Scribd served an anti-bot challenge instead of the document (Akamai "
    "'Client Challenge'). This is TLS/HTTP2 fingerprinting, not a cookie "
    "problem. Fix it with a real browser fingerprint:\n"
    "    pip install curl_cffi\n"
    "    python -m scribd \"<url>\" ... --cookies-file cookies.txt --impersonate chrome\n"
    "(curl_cffi is now in requirements.txt, so a fresh install already has it.)"
)

_TAG_RE = re.compile(r"<[^>]+>")


class ChallengeError(RuntimeError):
    """Raised when Scribd returns an anti-bot page instead of content."""


def looks_challenged(html: str) -> bool:
    """True if this response is a bot-check interstitial, not content."""
    if not html:
        return False
    head = html[:20000]
    return any(marker in head for marker in CHALLENGE_MARKERS)


def visible_text(html: str) -> str:
    """Crude tag stripper, only used for size sanity checks."""
    return _TAG_RE.sub(" ", html)


def is_substantive(html: str, *, min_chars: int = 200) -> bool:
    """Enough real text to be a document rather than an error page."""
    if looks_challenged(html):
        return False
    text = " ".join(visible_text(html).split())
    return len(text) >= min_chars
