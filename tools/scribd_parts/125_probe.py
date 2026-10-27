

def _probe(url: str, number: int) -> None:
    ctx = Ctx(url)
    if not ctx.ident:
        with JOB.lock:
            JOB.verdict = "BAD LINK"
            JOB.detail = "no document id in that URL"
        return
    if not ctx.load():
        with JOB.lock:
            JOB.verdict = "NO PAGES"
            JOB.detail = "the page named no pages"
        return
    JOB.say(f"probe: page {number} · token "
            + ("found (redacted)" if ctx.token.get() else "NONE FOUND"))
    # the viewer's own page: is the text of the whole book in it, and which
    # page numbers does it print? This one line answers "why is my page blank".
    viewer = ctx.viewer_pages()
    JOB.say(f"probe: viewer page: {ctx.embed_state or 'not read'}"
            + (f" · {viewer_fingerprint(ctx.embed_body)}" if ctx.embed_body else "")
            + (f" · pages it prints: {', '.join(str(n) for n in sorted(viewer)[:12])}"
               f"{' …' if len(viewer) > 12 else ''}" if viewer else ""))
    words = (viewer.get(number) or "").strip()
    if words:
        JOB.say(f"probe: viewer words for page {number}: {len(words)} chars")
        JOB.say("        " + redact(words, 300))
    elif viewer:
        JOB.say(f"probe: the viewer page has no words for page {number}")
    # The names the document gives are reported, and the descriptor beside an
    # image name is derived — that is where a page's WORDS are. No image is
    # fetched: a page is a photograph, and the probe says so further down.
    jsonps = list(ctx.sources.jsonps_for(number))
    for name in ctx.sources.images_for(number):
        JOB.say(f"probe: document name  {redact(name, 160)}")
        derived = jsonp_from_image(name)
        if derived and derived not in jsonps:
            jsonps.append(derived)
            JOB.say(f"probe: its descriptor {redact(derived, 160)} — derived: a "
                    "page's words sit beside its picture, under one hash")
    for jsonp in jsonps:
        JOB.say(f"probe: descriptor     {redact(jsonp, 160)}")
        for variant in ctx.jsonp_variants(jsonp):
            got = fetch(variant, ctx.jar, referer=ctx.document_url, timeout=20)
            JOB.say(f"  {got['status']:>3} {len(got['body']):>7} B  {redact(variant, 160)}"
                    + (f"   {http_reason(got)}" if got["status"] != 200 else ""))
            if got["status"] == 200 and got["body"]:
                JOB.say("        body: " + redact(got["body"][:800].decode("latin-1", "replace"), 300))
                # what the descriptor itself offers, by host and name only
                for url in ctx.assets_in(got["body"], number, ctx.token.get())[:4]:
                    JOB.say(f"        offers: {redact(url, 160)}")
    # The browser is the only thing that builds a page now, so it is the thing
    # worth probing: does one answer, and what does it make of this page?
    shooter = Shooter()
    if not shooter.alive():
        JOB.say("probe: browser " + (shooter.base or "none")
                + f" — does not answer: {shooter.note}")
    else:
        JOB.say(f"probe: browser {shooter.base} answers")
        page, note = shooter.shoot(ctx.ident, number)
        if page:
            JOB.say(f"probe: the browser's own picture of page {number}: "
                    f"{page['label']} — that is the page")
        else:
            JOB.say(f"probe: the browser has no picture of page {number}: {note}")
    with JOB.lock:
        JOB.verdict = "PROBE DONE"
        JOB.detail = f"page {number}"
