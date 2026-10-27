
def cookie_report(path: str) -> str:
    rows = read_cookie_lines(path)
    if not rows:
        return "no cookies loaded — anonymous"
    kept = scribd_only(path)
    domains = {parts[0].lstrip("#").lstrip(".").lower() for parts in rows}
    others = sorted(d for d in domains
                    if not (d.endswith("scribd.com") or d.endswith("scribdassets.com")))
    session = ([name for name in kept if name in ("_scribd_session", "scribd_session")]
               or [name for name in kept if "session" in name.lower()])
    text = (f"{len(kept)} scribd cookie(s)"
            + (f", session '{session[0]}'" if session else ", NO session"))
    if others:
        text += (f" · {len(rows) - len(kept)} cookie(s) for {len(others)} other "
                 f"site(s) NOT sent")
    return text
