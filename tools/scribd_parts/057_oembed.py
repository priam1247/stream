
def oembed(ident: str, jar: dict) -> dict:
    url = ("https://www.scribd.com/services/oembed?url="
           + urllib.parse.quote(f"https://www.scribd.com/document/{ident}", safe="")
           + "&format=json")
    got = fetch(url, jar, timeout=20)
    if got["error"] or got["status"] >= 400 or not got["body"]:
        return {}
    try:
        data = json.loads(got["body"].decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return {}
    return data if isinstance(data, dict) else {}
