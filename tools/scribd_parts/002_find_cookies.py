
# ---------------------------------------------------------------------------
# http — keep-alive, so 400 page files do not mean 400 TLS handshakes
# ---------------------------------------------------------------------------
def find_cookies() -> str:
    for candidate in (os.environ.get("COOKIES", ""),
                      os.environ.get("SCRIBD_WEB_COOKIES", ""),
                      os.environ.get("SCRIBD_DIAG_COOKIES", ""),
                      "cookies.txt", "./cookies.txt",
                      "/home/container/cookies.txt"):
        if candidate and os.path.isfile(candidate):
            return candidate
    return ""
