

def shot_get(url: str, timeout: float) -> tuple[int, bytes, str]:
    """A plain GET that is deliberately not `fetch()`.

    `fetch()` is for Scribd: it carries the session jar and, in local tests,
    rewrites every host onto --base. The browser service is neither of those,
    and a rewrite here would send the request to the wrong machine.
    """
    request = urllib.request.Request(url, headers={"User-Agent": UA,
                                                  "Accept": "image/png,*/*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            return answer.status, answer.read(), ""
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, exc.read(), ""
        except Exception:                       # noqa: BLE001
            return exc.code, b"", ""
    except Exception as exc:                    # noqa: BLE001
        return 0, b"", plain_error(exc)
