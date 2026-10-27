

def ping_answer(status: int, body: bytes, error: str) -> tuple[bool, str]:
    """What a /shot/ping answer means: (is a browser ready, and in what words).

    Read, not sniffed: a service with no browser in it still answers 200 and
    still says "ok" — with false after it. Believing that sends every missing
    page somewhere that cannot help, and the document ends up with the same
    placeholders, only slower.
    """
    if error:
        return False, error
    answer = None
    if body:
        try:
            answer = json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            answer = None
    if not isinstance(answer, dict):
        return False, (f"answered {status} with something that is not json"
                       if status == 200 else f"answered {status}")
    if answer.get("ok"):
        version = str(answer.get("version") or "").strip()
        return True, (f"troy-search {version}" if version else "ready")
    browser = answer.get("browser")
    why = (str(browser.get("note") or "").strip()
           if isinstance(browser, dict) else "")
    why = why or str(answer.get("error") or "").strip()
    return False, (why[:200] or f"answered {status} and said it is not ready")
