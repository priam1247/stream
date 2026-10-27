

def _download(url: str, limit: int, out: str, jobs: int = 12,
              name: str = "", check: bool = True,
              placeholder: bool = True, verify: bool = True,
              text: bool = False, gen: int = 0) -> None:
    ctx = Ctx(url, jobs)
    ctx.gen = gen or JOB.generation
    # One cheap question before any page is asked for: is there a browser to
    # photograph with? There is one route now and it runs through a browser, so
    # knowing early is what makes the rest of the job honest — with no browser,
    # only a page that has words of its own can still be built.
    shooter = Shooter()
    photographed: list[int] = []
    if shooter.base and shooter.alive():
        ctx.rest_budget = min(REST_BUDGET, SHOT_REST_BUDGET)
        JOB.say(f"browser on hand ({shooter.base}) — every page of this document "
                f"is photographed with it, so it rests at most "
                f"{ctx.rest_budget:.0f}s waiting on a page that is refusing")
    elif shooter.base:
        JOB.say(f"no browser at {shooter.base}: {shooter.note}")
        JOB.say("  with no browser there is nothing to photograph a page with, so "
                "only a page that has words of its own can still be built; the "
                "rest are left out of the PDF and named, never greyed. When pages "
                "are missing I will try to start that service myself")
    if not ctx.ident:
        with JOB.lock:
            JOB.verdict = "BAD LINK"
            JOB.detail = "no document id in that URL"
        return
    JOB.say(f"document {ctx.ident} · {socket.gethostname()} · python "
            f"{sys.version.split()[0]} · {cookie_report(ctx.cookie_path)}")
    if not ctx.load():
        with JOB.lock:
            JOB.verdict = "NO PAGES"
            JOB.detail = ("the page named no pages — is the session logged in?"
                          if ctx.total == 0 else "nothing to do")
        JOB.say("no page count and no page descriptors found")
        return

    with_limit = min(ctx.total, limit) if limit else ctx.total
    locked = ctx.locked_pages(with_limit)

    JOB.say(("downloading the first %d" % with_limit) if limit
            else "downloading the whole document")
    JOB.set_progress(page=0, of=with_limit, ok=0, skipped=0, blank=0)

    with _scrape_lock:
        _scrape_left[0] = SCRAPE_BUDGET
        _scrape_said[0] = False
    ctx.cache_dir = os.path.join(out, "cache", ctx.ident)
    ctx.debug_dir = os.path.join(out, "debug")
    os.makedirs(ctx.cache_dir, exist_ok=True)
    os.makedirs(os.path.join(out, "debug"), exist_ok=True)

    # ---- every document is photographed ------------------------------------
    # There is one load and one way a page is built: a browser photographs what
    # the viewer shows. A scanned upload and a converted upload are drawn by the
    # same viewer, so the photograph is the page for both.
    #
    # Whether the document's WORDS are worth one request per page is a separate
    # question, and one request answers it: a scan has none, and asking anyway
    # would spend hundreds of refusals and rest the job for nothing.
    has_words = ctx.gives_words()
    JOB.say("route: every page is photographed — one window and one measured "
            "clip per page"
            + (" · this document carries words, so they stay underneath every "
               "page, searchable" if has_words else
               " · this document carries no words of its own, so the "
               "photograph is the page"))
    # ---- one window per page, one clip of exactly that page ----------------
    # The browser opens the page's own address, measures the page's bounds in
    # that window, and photographs exactly those bounds: a capture can neither
    # lose the page's own edges nor carry its neighbour's. A page whose bounds
    # are missing, cut by the window, shared with a neighbour, or whose picture
    # does not match the measured bounds is a FAILED page with a reason — never
    # a picture of something else, and never a photograph of the window. The
    # words still come from the document, underneath, so the book stays
    # searchable.
    collected: dict[int, dict] = {}

    def shot_progress(done: int, ok: int, total: int) -> None:
        """Move the panel's numbers while pages are photographed one at a time.

        Twenty pages of silence is a panel that reads `page 0/20 · 0 ok · 159.7s`
        and looks dead, and a run that looks dead gets killed and started again,
        losing the pages that had already landed.
        """
        # "of" is the DOCUMENT's page count, never this pass's: a pass over one
        # page must not turn the panel's `page 20 of 20` into `page 20 of 1`,
        # which reads like a lie about the book
        of = max(int(with_limit), int(total), int(done))
        JOB.set_progress(page=min(len(collected) + int(done), of), of=of,
                         ok=len(collected) + int(ok))

    failed: list[int] = []
    text_pages: dict[int, str] = {}
    texts: dict[int, str] = {}     # the invisible text layer of a photographed page
    book_shot: list[int] = []
    shot_notes: list[str] = []
    asked = [number for number in range(1, with_limit + 1)
             if number not in locked]
    if not ctx.skip_now:
        shooter = ensure_shooter(shooter)
        if shooter.alive():
            JOB.say(f"photographing {len(asked)} page(s) at {shooter.base} — "
                    f"one window each, measured and clipped to the page's own "
                    f"bounds, at {shooter.scale:g}x")
            pictures, shot_notes = shooter.capture(
                ctx.ident, asked, jobs=ctx.jobs,
                alive=lambda: JOB.alive(ctx.gen), progress=shot_progress)
            collected.update(pictures)
            book_shot = sorted(pictures)
            for note in shot_notes:
                JOB.say("  " + note)
            # the browser's own words for why a page failed are the only honest
            # answer to "why is this page missing", and the debug file keeps all
            # of them, page by page
            missed_notes = [note for note in shot_notes
                            if "failed" in note or "refused" in note]
            if missed_notes:
                saved = ctx.save_shot_note("\n".join(missed_notes))
                if saved:
                    JOB.say(f"why, page by page: {saved}")
        else:
            JOB.say("no browser is reachable"
                    + (f" at {shooter.base}" if shooter.base else "")
                    + f": {shooter.note} — the words ladder runs instead, and a "
                    "page with no words and no photograph is left out and named")
    if collected and has_words:
        # The look came from the browser; the words come from the document,
        # underneath every photograph, so the book stays searchable. Only when
        # the document has words to give: a scanned page has none, and one
        # refused request per page would trip the throttle breaker and rest the
        # job for nothing.
        with ThreadPoolExecutor(max_workers=max(2, min(ctx.jobs, 8))) as pool:
            futures = {pool.submit(ctx.page_text, number): number
                       for number in sorted(collected)}
            for future in as_completed(futures):
                number = futures[future]
                try:
                    words = future.result()
                except Exception:                      # noqa: BLE001
                    words = ""
                if words and words.strip():
                    texts[number] = words
        JOB.say(f"words underneath: {len(texts)} of {len(collected)} "
                f"photographed page(s) are searchable")
    failed = [number for number in asked if number not in collected]
    thin: list[int] = []
    if failed and not ctx.skip_now:
        JOB.say(f"{len(failed)} page(s) no photograph reached — asking the "
                f"document for their words instead")
        with ThreadPoolExecutor(max_workers=max(2, min(ctx.jobs, 8))) as pool:
            futures = {pool.submit(ctx.descriptor_text, number): number
                       for number in list(failed)}
            for future in as_completed(futures):
                number = futures[future]
                try:
                    words = future.result()
                except Exception:                      # noqa: BLE001
                    words = ""
                if words_look_like_a_page(words):
                    text_pages[number] = words
                    failed = [n for n in failed if n != number]
                elif words and words.strip():
                    thin.append(number)
    if thin:
        JOB.say(f"{len(thin)} page(s) had words that were glyph shards, "
                f"not a page (half or more of its word-runs are one or two "
                f"letters — a font that would not decode) — left out and "
                f"named, not drawn as an empty sheet: "
                f"{', '.join(str(n) for n in thin[:12])}"
                + (" …" if len(thin) > 12 else ""))
    if failed:
        JOB.say(f"pages left out of the PDF (no photograph and no words "
                f"reached them): {', '.join(map(str, failed[:12]))}"
                + (" …" if len(failed) > 12 else ""))
    JOB.set_progress(page=with_limit, ok=len(collected),
                     skipped=len(failed))
    photographed.extend(book_shot)
    if not collected:
        # ---- when no photograph arrived at all ------------------------------
        # Not one page could be photographed, so every page is built from the
        # document's own words. A document
        # that has words reads them — they are drawn as pages, and photographed
        # over the top when a browser is there. A document with no words of its
        # own has every page photographed instead: the viewer's picture is the
        # page, and there is nothing else to fetch it from.
        done = 0
        if has_words:
            JOB.say("reading the pages the viewer renders — that is what a "
                    "browser shows you, and what this document is made of")
            # ONE request first: the viewer's scroll page carries every page's
            # words. Only what it does not have is asked for page by page.
            viewer = ctx.viewer_pages()
            if viewer:
                JOB.say(f"viewer: {ctx.embed_state} — its pages are the document, "
                        f"so they are drawn as pages")
                thin = [number for number in range(1, with_limit + 1)
                        if (viewer.get(number) or "").strip()
                        and not words_look_like_a_page(viewer.get(number))]
                for number in range(1, with_limit + 1):
                    words = (viewer.get(number) or "").strip()
                    if words and words_look_like_a_page(words):
                        text_pages[number] = viewer[number]
                        ctx.remember_text(number, viewer[number])
                if thin:
                    JOB.say(f"{len(thin)} page(s) of the viewer's words were "
                            f"glyph shards, not a page (a font that would not "
                            f"decode) — left out and named, not drawn as an "
                            f"empty sheet")
            missing = [number for number in range(1, with_limit + 1)
                       if number not in text_pages and number not in locked]
            done = len(text_pages)
            JOB.set_progress(page=done, ok=len(text_pages), skipped=len(missing))
            if missing and done:
                saved = ctx.save_viewer_page()
                if saved:
                    JOB.say(f"viewer: it carries no page text — the page as received "
                            f"is saved to {saved} (safe to send: no cookie in it)")
                JOB.say(f"text: {len(missing)} page(s) are not in the viewer page — "
                        f"asking their descriptors")
            with ThreadPoolExecutor(max_workers=max(2, min(ctx.jobs, 8))) as pool:
                futures = {pool.submit(ctx.descriptor_text, number): number
                           for number in missing}
                for future in as_completed(futures):
                    if not JOB.alive(ctx.gen):
                        for pending in futures:
                            pending.cancel()
                        JOB.say("stopped — no more pages read")
                        return
                    if ctx.skip_now:
                        for pending in futures:
                            pending.cancel()
                        break
                    number = futures[future]
                    try:
                        words = future.result()
                    except Exception:                      # noqa: BLE001
                        words = ""
                    if words.strip():
                        text_pages[number] = words
                    done += 1
                    JOB.set_progress(page=done, ok=len(text_pages),
                                     skipped=with_limit - len(text_pages))
                    if done % 10 == 0 or done == with_limit:
                        JOB.say(f"… {done}/{with_limit} pages, "
                                f"{len(text_pages)} with words")
            # A page with no words is still a page the viewer draws, so it is
            # photographed below. Nothing here asks Scribd for an image of a page
            # any more: that was the scan ladder, and it is gone.
            silent = [number for number in range(1, with_limit + 1)
                      if number not in text_pages and number not in locked]
            failed = sorted(silent)
            JOB.say(f"text: {len(text_pages)} of {with_limit} page(s) have words"
                    + (f" — {len(failed)} have none, and are photographed as the "
                       f"pages they are" if failed else ""))
            JOB.set_progress(ok=len(text_pages), skipped=len(failed))

        if not has_words:
            # No words to read and no image to fetch: what a page is, is what the
            # viewer draws, so every page of it is photographed one at a time —
            # the only route there is: one window and one measured clip per page.
            failed = [number for number in range(1, with_limit + 1)
                      if number not in collected and number not in locked]
            JOB.say(f"{len(failed)} page(s) to photograph one at a time — this "
                    f"document has no words of its own, so the viewer's own "
                    f"picture is the page")
            JOB.set_progress(page=0, of=with_limit, ok=len(collected), skipped=0)


        if ctx.skip_now:
            # The drop cancelled requests that had not been made yet. A page nobody
            # asked for is still a page the reader does not have, and it must be
            # counted: otherwise a dropped book reports itself as built with a
            # handful of placeholder sheets inside it.
            never_asked = [number for number in range(1, with_limit + 1)
                           if number not in collected and number not in text_pages
                           and number not in failed and number not in texts]
            if never_asked:
                failed = sorted(set(failed) | set(never_asked))
                JOB.say(f"{len(never_asked)} page(s) were never asked for — the "
                        f"queue moved on without them: they will be left out of "
                        f"the PDF and named, never greyed")

    # ---- no retries --------------------------------------------------------
    # A page Scribd refused is refused for a reason, and the very same request
    # again has never once brought one back — it only spends the reader's minutes
    # and holds every document in the queue behind it. Everything already fetched
    # is kept, a locked page is a failed page (photographed if a browser is on
    # hand, left out and named if not), and the book is built now.
    if locked:
        failed = sorted(set(failed) | locked)

    # ---- fidelity pass: photograph the pages that only arrived as words ---
    # Words keep a page's content but lose the document: a retypeset sheet is
    # not the page a reader saw in the viewer — no layout, no headings in
    # place, no page number. A browser sees exactly what the viewer shows, so
    # whenever one runs (or can be started) the viewer's own look is
    # photographed for those pages, and their words stay underneath as a
    # hidden, searchable layer. With no browser at all the words sheet
    # remains, because the content beats the look.
    word_only = sorted(number for number in text_pages
                       if number not in collected)
    if word_only and not ctx.skip_now:
        shooter = ensure_shooter(shooter)
    if word_only and shooter.alive() and not ctx.skip_now:
        JOB.say(f"photographing {len(word_only)} text page(s) with a browser "
                f"({shooter.base}) — the viewer's own look, with the words kept "
                f"underneath, searchable")
        pictures, shot_notes = shooter.capture(
            ctx.ident, word_only, jobs=ctx.jobs,
            alive=lambda: JOB.alive(ctx.gen), progress=shot_progress)
        for number in sorted(pictures):
            collected[number] = pictures[number]
            photographed.append(number)
            # the picture now IS the page's look, so its words go underneath as
            # the hidden searchable layer instead of a second, retypeset sheet
            if number in text_pages:
                texts[number] = text_pages.pop(number)
        for note in shot_notes:
            JOB.say("  " + note)
        left = [number for number in word_only if number not in collected]
        JOB.say(f"the viewer's look is in the PDF for {len(word_only) - len(left)}"
                f" of {len(word_only)} text page(s)"
                + (f" — {len(left)} keep their words sheet: the browser could "
                   f"not see them" if left else ""))
        JOB.set_progress(ok=len(collected) + len(
            [n for n in text_pages if n not in collected]), skipped=len(failed))

    # ---- a page nothing reached yet: photograph it ------------------------
    # This is the page that used to say "scan not available". Nothing arrived for
    # it and nothing was drawn for it — but a browser can still see it, and what
    # a browser sees is the page.
    if failed and not ctx.skip_now:
        # not alive at the start of the job is not an answer: ask past the
        # cache and, if nobody runs one, start the browser service myself
        shooter = ensure_shooter(shooter)
    if failed and shooter.alive() and not ctx.skip_now:
        JOB.say(f"photographing {len(failed)} page(s) with a browser "
                f"({shooter.base}) — a page nobody sent us is still a page "
                f"somebody can see")
        asked_for = len(failed)
        pictures, shot_notes = shooter.capture(
            ctx.ident, failed, jobs=ctx.jobs,
            alive=lambda: JOB.alive(ctx.gen), progress=shot_progress)
        for number in sorted(pictures):
            collected[number] = pictures[number]
            photographed.append(number)
        for note in shot_notes:
            JOB.say("  " + note)
        failed = [number for number in failed if number not in collected]
        # a page photographed as an empty sheet is still that page: it is in the
        # PDF, so it is not a placeholder — the note above says what it looks like
        JOB.say(f"photographed: {len(photographed)} of {asked_for} page(s) the "
                f"panel could not build"
                + (" — no placeholder left in this document" if not failed else
                   f" — {len(failed)} page(s) still have nothing")
                + (f" · {sample['label']}" if (sample := next(
                    (collected[n] for n in photographed), None)) else ""))
        JOB.set_progress(ok=len(collected) + len(
            [n for n in text_pages if n not in collected]), skipped=len(failed))
    elif failed and shooter.note:
        JOB.say(f"no browser to photograph {len(failed)} page(s)"
                + (f" at {shooter.base}" if shooter.base else "")
                + f": {shooter.note}")

    # ---- a page no photograph reached may still have words: use them -------
    # This is the case that made a 38-page document come out blank: its pages are
    # text the viewer renders, and each one of them used to be reported as "scan
    # not available". One descriptor request per page that is still missing turns
    # it into a page you can actually read. It runs AFTER the photographs, not
    # before: a photograph is the page, and asking for words first only spends
    # requests on pages a browser was about to draw.
    if failed and not has_words:
        JOB.say(f"no photograph for {len(failed)} page(s) — asking the document "
                f"for their words")
        rescued: list[int] = []
        thin: list[int] = []
        for number in sorted(failed):
            if not JOB.alive(ctx.gen):
                break
            words = ctx.page_text(number)
            if words_look_like_a_page(words):
                text_pages[number] = words
                rescued.append(number)
            elif words.strip():
                thin.append(number)
        if thin:
            JOB.say(f"{len(thin)} page(s) had words that were glyph shards, "
                    f"not a page (half or more of its word-runs are one or two "
                    f"letters — a font that would not decode) — left out and "
                    f"named, not drawn as an empty sheet: "
                    f"{', '.join(str(n) for n in thin[:12])}"
                    + (" …" if len(thin) > 12 else ""))
        if rescued:
            for number in rescued:
                rows = [line for line in ctx.trace.get(number, [])
                        if "403" in line or "AccessDenied" in line]
                JOB.say(f"page {number}: no photograph (it is text in this "
                        f"document) — wrote its words instead"
                        + ("" if not rows else " · its picture was refused with 403"))
            failed = [number for number in failed if number not in text_pages]
            JOB.set_progress(ok=len(collected) + len(text_pages),
                             skipped=len(failed))
            JOB.say(f"{len(rescued)} page(s) came from the document's text — "
                    + ("the PDF is complete, no placeholder"
                       if not failed else
                       f"{len(failed)} page(s) still have neither a photograph "
                       f"nor words"))
        if failed and not rescued:
            # nothing came from the text either: keep what Scribd actually sent
            saved = ctx.save_viewer_page()
            if saved:
                JOB.say(f"viewer page saved to {saved} (no cookie in it) — that "
                        f"file says what the viewer really sends")


    # ---- the size of this book -------------------------------------------
    # Every page is a photograph cut at the column's own size, so the book's size
    # is the MEDIAN of those photographs: one odd page cannot shape it. Nothing is
    # refetched, because there is no second copy of a photograph to go and ask
    # for — what the viewer showed is what the page is.
    reference = median_page(list(collected.values())) if collected else (0, 0)

    # ---- the words of each page, so the PDF is not just photographs --------
    if text and collected:
        JOB.say("text: asking for each page's words (one extra request per page)")
        for number in sorted(collected):
            words = ctx.page_text(number)
            if words:
                texts[number] = words
        JOB.say(f"text: {len(texts)} of {len(collected)} page(s) had words")

    # A book of photographs has no scan to agree a size with, so no sheet is made
    # uniform: each one keeps the size of the page on it.
    sheets = sheet_list(collected, with_limit, placeholder)
    if not sheets:
        # a document with no pictures at all: one sheet per page, A4
        sheets = [None] * with_limit
    if reference[0]:
        sheet = (round(reference[0] * 0.75, 2), round(reference[1] * 0.75, 2))
    elif text_pages:
        sheet = (595.0, 842.0)
    else:
        sheet = (0.0, 0.0)

    fit_shots(collected, sheet)

    with open(os.path.join(out, "debug", "pages.txt"), "w") as handle:
        handle.write(f"document {ctx.ident} · title {ctx.title!r} · "
                     f"author {ctx.author!r}\n")
        word_sheets = sum(1 for pos, sh in enumerate(sheets, start=1)
                          if sh is None and (text_pages.get(pos) or "").strip())
        left_out = sum(1 for pos, sh in enumerate(sheets, start=1)
                       if sh is None and not (text_pages.get(pos) or "").strip())
        handle.write(f"pages in document: {ctx.total} · photographed: "
                     f"{len(collected)} · drawn from their own words: "
                     f"{word_sheets} · left out and named: {left_out}\n")
        handle.write(f"page size: {reference[0]}x{reference[1]} px · "
                     f"sheet {sheet[0]}x{sheet[1]} pt · every sheet keeps "
                     f"the size of the page on it\n")
        if ctx.rejected:
            handle.write("arrived but unreadable: "
                         + ", ".join(f"{count} {kind}" for kind, count in
                                     sorted(ctx.rejected.items())) + "\n")
        for number in range(1, with_limit + 1):
            page = collected.get(number)
            if page:
                handle.write(f"{number:4d}  {page['width']}x{page['height']}"
                             f"  rot {page.get('rotate', 1)}"
                             f"  {page.get('bytes', 0) / 1000:7.0f} kB"
                             f"  [{page.get('phase', '?')}]"
                             f"  {page.get('url', '')[:130]}\n")
            elif (text_pages.get(number) or "").strip():
                handle.write(f"{number:4d}  WORDS    drawn as a text sheet "
                             f"({len(text_pages[number])} chars) — no photograph "
                             f"reached this page, and its words are on it\n")
            else:
                handle.write(f"{number:4d}  LEFT OUT no photograph, no words — "
                             f"not in the PDF, and named in the verdict\n")
        if ctx.notes:
            handle.write("\nnotes:\n" + "\n".join(sorted(ctx.notes)) + "\n")

    if failed:
        with open(os.path.join(out, "debug", "failed-pages.txt"), "w") as handle:
            handle.write(f"document {ctx.ident} · {len(failed)} page(s) failed\n")
            for number in sorted(failed):
                handle.write(f"\npage {number} — every name tried, and its answer:\n")
                for line in ctx.trace.get(number, []):
                    handle.write("  " + line + "\n")
            if ctx.notes:
                handle.write("\nnotes:\n" + "\n".join(sorted(ctx.notes)) + "\n")
        with open(os.path.join(out, "debug", "missing-pages.txt"), "w") as handle:
            handle.write(", ".join(str(n) for n in failed) + "\n")
        codes: dict[str, int] = {}
        for number in failed:
            for line in ctx.trace.get(number, []):
                parts = line.split()
                code = parts[0] if parts else "?"
                codes[code] = codes.get(code, 0) + 1
        order = sorted(codes.items(), key=lambda row: -row[1])[:4]
        JOB.say("why: " + " · ".join(f"{count} answer(s) {code}"
                                     for code, count in order))
        if codes.get("403", 0) >= sum(codes.values()) * 0.6:
            JOB.say("     403 is the only answer: either those pages are not for "
                    "this account, or Scribd is still throttling this address — "
                    "run it again later, the finished pages are cached")
        if ctx.rejected:
            JOB.say("     arrived but unreadable: "
                    + ", ".join(f"{count} {kind}" for kind, count in
                                sorted(ctx.rejected.items())))
        for number in sorted(failed)[:3]:
            lines = ctx.trace.get(number, [])
            names = len(ctx.tried.get(number, ()))
            JOB.say(f"page {number}: {names} name(s) tried, "
                    f"nothing usable came back ({len(lines)} request(s))")
            for line in lines[:4]:
                JOB.say("   " + line)

    if not collected and not text_pages:
        kinds = ", ".join(f"{count} {kind}" for kind, count in
                          sorted(ctx.rejected.items(), key=lambda row: -row[1]))
        if ctx.rejected:
            why = (f"{sum(ctx.rejected.values())} page file(s) arrived but none could "
                   f"be read as a page image ({kinds})")
            if "webp" in ctx.rejected:
                why += (" · webp needs Pillow: this build reads jpeg and png alone. "
                        "Run --probe 1 to see the file that arrived")
        else:
            why = ("no page could be photographed and no page's words could be "
                   "read — see downloads/debug/"
                   + ("" if ctx.token.get() else
                      " · no browser answered and the document named no words: "
                      "a document of page scans is fetched without a browser, "
                      "so this one is a converted document with nothing to "
                      "photograph it — start the /shot service"))
        waited, aged = JOB.waiting(), ctx.age()
        with JOB.lock:
            if ctx.skip_now:
                JOB.verdict = "DROPPED"
                JOB.detail = (f"{aged:.0f}s of refusals, nothing arrived, "
                              f"{waited} document(s) waiting — dropped by the "
                              f"queue and moved on; not retried")
            else:
                JOB.verdict = "NO PAGES"
                JOB.detail = why
        for number in sorted(ctx.tried)[:3]:
            JOB.say(f"page {number}: {len(ctx.tried[number])} name(s) tried")
            for line in ctx.trace.get(number, [])[:3]:
                JOB.say("   " + line)
        return

    if failed and os.environ.get("SCRIBD_STRICT_PAGES", "0") == "1":
        # some deployments would rather have no book than a book with holes
        with JOB.lock:
            JOB.verdict = "FAILED"
            JOB.detail = (f"{len(failed)} page(s) have no source at all — no "
                          f"scan, no words, no browser that could photograph "
                          f"them: {failed[:20]}; SCRIBD_STRICT_PAGES refuses "
                          f"to save a book with holes")
        return

    stem = safe_name(name, "") or ctx.title or f"scribd-{ctx.ident}"
    target = os.path.join(out, f"{stem}.pdf")
    suffix = 2
    while os.path.exists(target) and suffix <= 50:
        target = os.path.join(out, f"{stem} ({suffix}).pdf")
        suffix += 1

    # uniform=False: every sheet keeps the MediaBox of the page on it. A book of
    # photographs was cut at one column's size, so the sheets agree anyway; a page
    # photographed on its own may not, and it must not be stretched to match.
    ok, note_text = build_pdf(sheets, target, title=ctx.title, author=ctx.author,
                              uniform=False, texts=texts, text_pages=text_pages)
    if not ok:
        with JOB.lock:
            JOB.verdict = "FAILED"
            JOB.detail = note_text
        return

    if verify:
        drawn = len(sheets) - sum(1 for pos, sh in enumerate(sheets, start=1)
                                  if sh is None and not text_pages.get(pos))
        sound, report = verify_pdf(target, expect_pages=drawn,
                                   expect_images=len(collected), uniform=False)
        JOB.say("verify: " + report)
        if not sound:
            with JOB.lock:
                JOB.file = target
                JOB.verdict = "PDF BROKEN"
                JOB.detail = f"{os.path.basename(target)} — {report}"
            return

    with JOB.lock:
        JOB.file = target
        JOB.verdict = ("DROPPED" if ctx.skip_now and failed else
                       "PDF BUILT" if not failed else "PDF PARTIAL")
        asked = with_limit if limit else ctx.total
        real_pages = len(set(collected) | set(text_pages))
        drawn_text = sum(1 for number in text_pages if number not in collected)
        JOB.detail = (f"{note_text} · {real_pages} of {asked} page(s) real"
                      + (f" of {ctx.total} in the document" if limit and
                         with_limit < ctx.total else "")
                      + (f" · {drawn_text} from text" if drawn_text else "")
                      + (f" · {len(photographed)} photographed"
                         if photographed else "")
                      + (f" · {len(failed)} omitted" if failed else "")
                      + (" · dropped by the queue" if ctx.skip_now else "")
                      + (" · verified" if verify else ""))
    if failed:
        JOB.say("pages left out of the PDF (no photograph, no words): "
                + ", ".join(str(n) for n in failed[:60])
                + (" …" if len(failed) > 60 else ""))
        JOB.say("why, page by page: downloads/debug/failed-pages.txt")
    if ctx.skip_now:
        JOB.say(f"dropped itself after {ctx.age():.0f}s: {len(failed)} page(s) "
                f"were only refusals and the queue was waiting — they are left "
                f"out of the PDF and named in the verdict; not retried")

    # a small disk fills up quietly; say what was cleaned instead of hiding it
    for line in prune_out(out):
        JOB.say(line)
        JOB.say("to see every name and answer for one of them: --probe <page>")
    JOB.say(f"written: {target}")
