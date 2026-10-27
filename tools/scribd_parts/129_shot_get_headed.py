

def shot_get_headed(url: str, timeout: float
                    ) -> tuple[int, bytes, str, dict[str, str]]:
    """shot_get, plus the answer's headers.

    The browser service states the box it measured in `X-Shot-Box`, because the
    panel checks every picture against the box it claims to be: a picture that
    is not the size of its own page is a picture of something else, and the
    shooter's word alone is not the check.
    """
    request = urllib.request.Request(url, headers={"User-Agent": UA,
                                                  "Accept": "image/png,*/*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            return (answer.status, answer.read(), "",
                    {k.lower(): v for k, v in answer.headers.items()})
    except urllib.error.HTTPError as exc:
        # an HTTP answer is an answer: the status and body carry the reason,
        # exactly as shot_get has always reported them
        return exc.code, exc.read() or b"", "", {}
    except Exception as exc:                                 # noqa: BLE001
        return 0, b"", str(exc), {}
