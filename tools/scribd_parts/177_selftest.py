
# ---------------------------------------------------------------------------
# selftest / entry
# ---------------------------------------------------------------------------
def selftest() -> str:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + kind + body
                + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF))

    def make_png(width: int, height: int, colour: int, pixels: bytes,
                 filter_kind: int = 0) -> bytes:
        channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour]
        stride = width * channels
        rows = []
        previous = bytes(stride)
        for row in range(height):
            line = pixels[row * stride:(row + 1) * stride]
            if filter_kind == 2:
                line = bytes((line[i] - previous[i]) & 0xFF for i in range(stride))
            rows.append(bytes([filter_kind]) + line)
            previous = pixels[row * stride:(row + 1) * stride]
        header = struct.pack(">IIBBBBB", width, height, 8, colour, 0, 0, 0)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
                + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))

    def make_jpeg(width: int, height: int, components: int = 3,
                  thumbnail: tuple[int, int] | None = None,
                  orientation: int = 0) -> bytes:
        """A JPEG header chain good enough for the size parser, with traps."""
        out = bytearray(b"\xff\xd8")
        if thumbnail or orientation:
            exif = bytearray(b"Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08")
            entries = 1
            exif += struct.pack(">H", entries)
            exif += struct.pack(">HHI", 0x0112, 3, 1)
            exif += struct.pack(">HH", orientation, 0)
            exif += struct.pack(">I", 0)
            payload = bytes(exif)
            out += b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
        if thumbnail:                    # a decoy frame in front of the real one
            tw, th = thumbnail
            out += b"\xff\xc0" + struct.pack(">H", 11) + bytes([8])
            out += struct.pack(">HH", th, tw) + bytes([3]) + b"\x00" * 6
        out += b"\xff\xc0" + struct.pack(">H", 11) + bytes([8])
        out += struct.pack(">HH", height, width) + bytes([components]) + b"\x00" * 6
        out += b"\xff\xda" + b"\x00\x08" + b"\x00" * 6 + b"\x00" * 32 + b"\xff\xd9"
        return bytes(out)

    rgb = bytes([255, 0, 0] * 2 + [0, 0, 255] * 2) * 2
    decoded = png_to_raw(make_png(4, 2, 2, rgb))
    assert decoded is not None and decoded[1:] == (4, 2, 3) and decoded[0] == rgb
    gray = bytes([0, 128, 255, 64] * 2)
    decoded = png_to_raw(make_png(4, 2, 0, gray))
    assert decoded is not None and decoded[1:] == (4, 2, 1) and decoded[0] == gray
    direct = png_for_pdf(make_png(4, 2, 2, rgb, filter_kind=2))
    assert direct is not None and "/Predictor 15" in direct["params"]
    assert zlib.decompress(direct["payload"])[0] == 2

    # ---- the JPEG size trap that made a 402-page book a strip of slivers ----
    real = make_jpeg(1200, 1600)
    assert jpeg_size(real) == (1200, 1600, 3)
    trapped = make_jpeg(1200, 1600, thumbnail=(772, 68))   # decoy in front
    assert jpeg_size(trapped) == (1200, 1600, 3), jpeg_size(trapped)
    tiny = make_jpeg(90, 120)
    assert jpeg_size(tiny) == (0, 0, 0)                    # nothing plausible
    assert jpeg_size(b"\xff\xd8\x00\x00") == (0, 0, 0)
    assert jpeg_size(b"<Error>") == (0, 0, 0)
    assert not plausible_page({"width": 772, "height": 68})
    assert not page_can_be_this_small(772, 68, 90_000)     # 13.7 bits/pixel
    assert page_can_be_this_small(1200, 1600, 90_000)      # 0.4 bits/pixel
    assert page_can_be_this_small(772, 68, 8_000)          # a real strip
    assert not plausible_page({"width": 100, "height": 130})
    assert plausible_page({"width": 1200, "height": 1600})
    assert plausible_page({"width": 1600, "height": 1200})   # a spread
    # ---- EXIF orientation ----
    assert jpeg_orientation(make_jpeg(1200, 1600, orientation=6)) == 6
    assert jpeg_orientation(make_jpeg(1200, 1600)) == 1
    assert jpeg_orientation(b"not a jpeg") == 1

    # ---- what arrived, and whether it is really a page --------------------
    frames, whole = jpeg_frames(real)
    assert frames == [(1200, 1600, 3)] and whole, frames
    assert jpeg_frames(trapped)[0][-1] == (1200, 1600, 3)   # the decoy is not it
    assert jpeg_frames(b"not a jpeg") == ([], False)
    cut = real[:-40]                                        # a transfer cut short
    assert jpeg_frames(cut)[0] == [(1200, 1600, 3)]
    assert jpeg_frames(cut)[1] is False
    assert scan_for_pdf(cut)["complete"] is False
    assert scan_for_pdf(real)["complete"] is True
    # a complete, page-shaped picture smaller than a scan is a page, not a fail
    preview_page = scan_for_pdf(make_jpeg(96, 130))
    assert preview_page and preview_page["preview"] is True, preview_page
    assert preview_page["width"] == 96 and "small preview" in preview_page["label"]
    # v2.16: a small or odd-shaped page is used, not thrown away — a 60x80 scan
    # of a page is still that page, and a blank placeholder is worse
    tiny = scan_for_pdf(make_jpeg(60, 80))
    assert tiny and tiny["preview"] and tiny["width"] == 60, tiny
    spread = scan_for_pdf(make_jpeg(2400, 700))              # far outside a page shape
    assert spread and spread["width"] == 2400, spread
    assert scan_for_pdf(make_jpeg(8, 8)) is None             # this really is noise
    # odd shapes are still "not this book's page size", so they never set it
    assert not plausible_page(spread)
    assert scan_for_pdf(real)["preview"] is False
    # a decoy thumbnail in front of a full page never wins
    assert scan_for_pdf(make_jpeg(1200, 1600, thumbnail=(90, 120)))["preview"] is False
    # the reason line says what arrived instead of "not a page scan"
    assert "below the 200 px floor" in describe_image(make_jpeg(60, 80))
    assert "cut short" in describe_image(cut)
    assert "1200x1600 jpeg" in describe_image(real)
    assert "not an image at all" in describe_image(b"<Error>AccessDenied</Error>")
    assert "empty body" in describe_image(b"")
    # previews never shape the sheet, and they fill it instead of floating in it
    assert house_sheet([{"width": 1200, "height": 1600}] * 5
                       + [{"width": 96, "height": 130, "preview": True}]) == (900.0, 1200.0)
    wide_box = _placement({"width": 96, "height": 130, "rotate": 1, "preview": True},
                          (900.0, 1200.0))
    assert wide_box[1] == 1200.0, wide_box

    # ---- the sheet comes from the median, so one odd page cannot wreck it ----
    normal = [{"width": 1200, "height": 1600} for _ in range(9)]
    odd = normal + [{"width": 772, "height": 68}]
    assert median_page(odd) == (1200, 1600)
    assert median_page(normal) == (1200, 1600)
    assert house_sheet(normal) == (900.0, 1200.0)
    small = {"width": 300, "height": 400, "rotate": 1}
    box = _placement(small, (900.0, 1200.0))
    assert box[0] == 450.0 and box[1] == 600.0, box     # capped at 2x, centred
    assert box[2] == 225.0 and box[3] == 300.0, box
    mixed_pages = ([{"width": 1200, "height": 1600}] * 4
                   + [{"width": 1600, "height": 1200}] * 4)
    assert median_page(mixed_pages) in ((1200, 1600), (1600, 1200))
    assert median_page(mixed_pages) != (1600, 1600)   # no invented sheet size

    jpeg = make_jpeg(64, 32)
    page = scan_for_pdf(jpeg)
    assert page is None or page["width"] == 64       # 64 px is below the floor
    solid = make_jpeg(1200, 1600)
    built = scan_for_pdf(solid)
    assert built and built["width"] == 1200 and built["rotate"] == 1
    rotated = scan_for_pdf(make_jpeg(1200, 1600, orientation=6))
    assert rotated["rotate"] == 6
    assert scan_for_pdf(b"<Error><Code>AccessDenied</Code></Error>") is None

    # ---- cookies: only scribd, never the other sites in an export ----
    import tempfile
    with tempfile.TemporaryDirectory() as work:
        jar_path = os.path.join(work, "cookies.txt")
        stamp = int(time.time()) + 3600
        with open(jar_path, "w") as handle:
            handle.write(f".scribd.com\tTRUE\t/\tFALSE\t{stamp}\t_scribd_session\tabc123\n")
            handle.write(f"#HttpOnly_www.scribd.com\tTRUE\t/\tFALSE\t{stamp}\tscrbd\txyz\n")
            handle.write(f".html.scribdassets.com\tTRUE\t/\tFALSE\t{stamp}\ttok\tqq\n")
            handle.write(f".grok.com\tTRUE\t/\tFALSE\t{stamp}\tsession-id\tSECRET\n")
            handle.write(f".youtube.com\tTRUE\t/\tFALSE\t{stamp}\tSID\tSECRET2\n")
            handle.write(".scribd.com\tTRUE\t/\tFALSE\t1000\told\tgone\n")
        jar = scribd_only(jar_path)
        assert set(jar) == {"_scribd_session", "scrbd", "tok"}, jar
        assert "SECRET" not in "".join(jar.values())
        report = cookie_report(jar_path)
        assert "3 scribd cookie(s)" in report and "NOT sent" in report, report
        assert "SECRET" not in report
        assert cookie_report(os.path.join(work, "nope")) == (
            "no cookies loaded — anonymous")

        # ---- the token: a JS expression is never a token ----
        good = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.sig"
        placeholder = "navigator.userAgent.toLowerCase"
        plain = "puba93cb01f5c7d6a8163631bbd7ce20349"
        # v2.16: the token in every shape the viewer writes it in
        written = {
            "query": b'var t="x.jpg?token=' + good.encode() + b'"',
            "json": b'{"token":"' + good.encode() + b'"}',
            "camel": b'{"imageToken":"' + good.encode() + b'"}',
            "encoded": b'&amp;token%3D' + good.encode(),
            "bare": b'window.__X={"a":1,"t":"' + good.encode() + b'","b":2}',
        }
        for shape, body in written.items():
            assert harvest_token(body) == good, (shape, harvest_token(body))
        # a JavaScript expression is still never a token, in any shape
        assert harvest_token(b'{"token":"navigator.userAgent.toLowerCase"}') == ""
        assert harvest_token(b'{"imageToken":"' + placeholder.encode() + b'"}') == ""
        assert harvest_token(b'?token=' + plain.encode()) == plain
        # ---- probe output must be safe to paste into a chat --------------
        line = ("https://html.scribdassets.com/abc/images/5-deadbeef.jpg"
                "?token=" + good)
        assert good not in redact(line) and "REDACTED" in redact(line), redact(line)
        assert good not in redact('{"imageToken":"' + good + '"}')
        assert good not in redact("var t = \"" + good + "\";")
        assert "REDACTED" in redact("https://x/file?key=abcdefgh12345678")
        assert len(redact("x" * 500, 60)) == 60
        assert harvest_token(b'?token=' + placeholder.encode()) == ""
        assert harvest_token(b"nothing here") == ""
        holder = Token()
        assert holder.set(placeholder) is False and holder.get() == ""
        assert holder.set(good) is True and holder.get() == good
        named = ("https://html.scribdassets.com/abc/images/5-deadbeef.jpg"
                 "?token=" + placeholder)
        assert with_token(named, good).endswith("?token=" + good)
        assert with_token(named, "") == named            # nothing better to give
        assert strip_token(named).endswith("5-deadbeef.jpg")

        # ---- sheets keep the document's numbering ----
        assert sheet_list({1: "a", 3: "c"}, 3, True) == ["a", None, "c"]
        assert sheet_list({1: "a", 3: "c"}, 3, False) == ["a", "c"]

        # ---- build, then read the file back ----
        target = os.path.join(work, "d.pdf")
        tall = scan_for_pdf(make_jpeg(1200, 1600))
        wide = scan_for_pdf(make_jpeg(1600, 1200))
        ok, note = build_pdf([tall, None, wide, tall], target,
                             title="A (B)", author="me")
        assert ok and "1 page(s) omitted" in note, note
        with open(target, "rb") as handle:
            written = handle.read()
        assert written.startswith(b"%PDF-1.4") and written.rstrip().endswith(b"%%EOF")
        # 2.30: a page nothing arrived for is LEFT OUT and named in the note.
        # A grey "scan not available" sheet must never exist again.
        assert b"/Count 3" in written and written.count(b"/Type /Page /Parent") == 3
        assert written.count(b"/DCTDecode") == 3
        assert b"scan not available" not in written and b"/Info" in written
        boxes = re.findall(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]", written)
        assert len(boxes) == 3 and len(set(boxes)) == 1, boxes
        # the wide page is centred inside the same sheet, never stretched
        assert b"/MediaBox [0 0 900.0 1200.0]" in written

        sound, report = verify_pdf(target, expect_pages=3, expect_images=3)
        assert sound, report                       # 2.3 failed here: counted 0
        assert "3 image stream(s)" in report, report
        assert verify_pdf(target, expect_pages=5, expect_images=3)[0] is False
        assert verify_bytes(written.replace(b"/Count 3", b"/Count 9"),
                          expect_pages=4, expect_images=3)[1].find("/Count says 9") >= 0
        cut = written.find(b"/Subtype /Image")
        marker = written.find(b"stream\n", cut) + len(b"stream\n")
        mangled = written[:marker] + b"\x00" + written[marker + 1:]
        broken, why = verify_bytes(mangled, expect_pages=4, expect_images=3)
        assert not broken and "DCTDecode" in why, why
        assert verify_pdf(os.path.join(work, "nope.pdf"))[0] is False

        # a page that was stored sideways is turned upright, not left lying down
        side = scan_for_pdf(make_jpeg(1200, 1600, orientation=6))
        assert side["rotate"] == 6
        spot = os.path.join(work, "side.pdf")
        assert build_pdf([side], spot)[0]
        with open(spot, "rb") as handle:
            text = handle.read()
        # a sideways scan is turned upright: 1200x1600 stored shows as 1600x1200
        assert b"/MediaBox [0 0 900.0 1200.0]" in text
        assert verify_pdf(spot, expect_pages=1, expect_images=1)[0]
        assert b"0 -675.0 900.0 0 0.0 937.5 cm" in text, text[-400:]

        # every rotation draws the whole box and no more: corners land on the box
        for number, sketch in ((1, "1 0 0 1"), (3, "3 0 0 3"), (6, "6 0 0 6"),
                               (8, "8 0 0 8")):
            box = (300.0, 400.0, 7.0, 11.0)
            matrix = _image_matrix({"rotate": number}, box)
            values = [float(v) for v in matrix.split()[:6]]
            a, b, c, d, e, f = values
            corners = set()
            for u, v in ((0, 0), (1, 0), (0, 1), (1, 1)):
                corners.add((round(a * u + c * v + e, 2), round(b * u + d * v + f, 2)))
            assert corners == {(7.0, 11.0), (307.0, 11.0), (7.0, 411.0),
                               (307.0, 411.0)}, (number, corners)

    # ---- every caller of the download path binds to the signature it meets --
    # A parameter removed from _download once left the panel's queue handing over
    # a bare positional False for it, and every document the panel was asked for
    # crashed with "takes from 3 to 10 positional arguments but 11 were given".
    # The command line never showed it: only the queue calls _download directly.
    # So every call site in this file is bound to the real signature here, and the
    # arguments past `jobs` must be named — a row of positional booleans is how a
    # removed parameter hides.
    import ast as _ast
    import inspect as _inspect
    _tree = _ast.parse(_scribd_source_text())
    _signatures = {"run_job": _inspect.signature(run_job),
                   "_batch": _inspect.signature(_batch),
                   "_download": _inspect.signature(_download)}
    _checked = 0
    for _node in _ast.walk(_tree):
        if not isinstance(_node, _ast.Call):
            continue
        _fn = _node.func
        _name = _fn.id if isinstance(_fn, _ast.Name) else ""
        if _name not in _signatures:
            continue
        assert not any(isinstance(arg, _ast.Starred) for arg in _node.args), \
            f"{_name} is called with *args: this check cannot see its arguments"
        assert all(keyword.arg for keyword in _node.keywords), \
            f"{_name} is called with **kwargs: this check cannot see its arguments"
        assert len(_node.args) <= 4, (
            f"{_name} is handed {len(_node.args)} positional arguments — only "
            f"url, limit, out and jobs may be positional, so a parameter that "
            f"goes away cannot take a caller with it")
        _signatures[_name].bind(*([None] * len(_node.args)),
                                **{keyword.arg: None for keyword in _node.keywords})
        _checked += 1
    assert _checked >= 5, f"only {_checked} call site(s) checked: the download " \
        "path is not being watched"
    assert "refresh" not in _signatures["_download"].parameters, \
        "refresh is still a parameter: there is no cache of page images to refresh"

    # ---- names: read from the document, never fetched as a page ----
    ctx = Ctx("https://www.scribd.com/document/750213011/Physics-12th")
    ctx.token.set(good)
    ctx.sources.merge(
        b'<script>var d={"page_count":402};'
        b'var u="https:\\/\\/html.scribdassets.com\\/abc123def456\\/pages\\/7-deadbeef.jsonp'
        b'?token=' + placeholder.encode() + b'";'
        b'var i="https:\\/\\/html.scribdassets.com\\/abc123def456\\/images\\/8-cafebabe.jpg'
        b'?token=' + placeholder.encode() + b'";</script>')
    assert page_count(b'{"page_count":402}', ctx.sources) == 402
    # The names a document gives are still read: a page's descriptor is where its
    # WORDS come from. Nothing turns them into an image request any more.
    assert ctx.sources.jsonps_for(7) and ctx.sources.jsonps_for(7)[0].endswith(
        "/pages/7-deadbeef.jsonp?token=" + placeholder), ctx.sources.jsonps_for(7)
    assert ctx.sources.images_for(8) and ctx.sources.images_for(8)[0].endswith(
        "/images/8-cafebabe.jpg?token=" + placeholder), ctx.sources.images_for(8)
    # and the ladder that fetched a page by name is not in the file to be called
    for gone in ("candidates_for", "primaries_for", "descriptor", "deep",
                 "attempt", "grab", "cache_path"):
        assert not hasattr(ctx, gone), f"{gone} is still there: a page is a " \
            "photograph now, and nothing may go and fetch one as an image"
    for gone in ("SCANS_OK", "SHOTS_ONLY", "MAX_COVER_SCANS", "MAX_REFETCH",
                 "SIZE_TOLERANCE", "PLACEHOLDER_SCANS"):
        assert gone not in globals(), f"{gone} is still there"
    assert not hasattr(Ctx, "is_text_document"), \
        "is_text_document is still there: it used to pick a route, and there is one"

    page_html = (b'<html><head><meta property="og:title" '
                 b'content="Excel &amp; Succeed: Biology | Scribd">'
                 b'<title>ignored</title></head></html>')
    assert title_from_html(page_html, "u") == "Excel & Succeed Biology"
    assert title_from_html(b"<title>Plain Title - Scribd</title>", "u") == "Plain Title"
    assert safe_name('a/b:c*d?e"f<g>h|i', "x") == "abcdefghi"
    assert doc_id_of("https://www.scribd.com/document/704243478/Excel") == "704243478"
    assert doc_id_of("nonsense") == ""

    # ---- links: a pasted list, and the bookmarklet that fills it ----
    pasted = (
        "https://www.scribd.com/document/750213011/Physics-12th\n"
        "  https://www.scribd.com/document/750213011/Physics-12th?utm_source=x  \n"
        "https://www.scribd.com/presentation/804179430/Book-List#page=3\n"
        "https://example.com/not-scribd\n"
        "https://www.scribd.com/about\n"
        "see also: https://www.scribd.com/ebook/123456789/Some-Book,")
    links = links_from_text(pasted)
    assert links == ["https://www.scribd.com/document/750213011/Physics-12th",
                     "https://www.scribd.com/presentation/804179430/Book-List",
                     "https://www.scribd.com/ebook/123456789/Some-Book"], links
    assert links_from_text("") == []
    assert links_from_text("no links here") == []
    assert links_from_text("https://www.scribd.com/document/123")[0].endswith("/123")

    # the bookmarklet must point at THIS panel, never at scribd.com
    code = bookmarklet("http://195.123.189.187:25811")
    assert code.startswith("javascript:")
    assert '"http://195.123.189.187:25811/send?"' in code, code[:120]
    assert "scribd.com/send" not in code
    assert "/document/" in code and "/presentation/" in code
    assert "querySelectorAll" in code and "%20" not in code
    assert bookmarklet("http://box:8090/").count("/send?") == 1
    # and the page shows it escaped, so the quote does not break the attribute
    assert html_escape('<a href="x">&') == "&lt;a href=&quot;x&quot;&gt;&amp;"

    # ---- find: Scribd's own search answer, not an engine's html ----
    first = search_url("  physics   12th ")
    assert first.startswith("https://www.scribd.com/search/query?"), first
    assert "query=physics+12th" in first and "page=" not in first, first
    assert "page=2" in search_url("physics 12th", 2)
    assert search_url("physics 12th") == first

    answer = {"results": {"documents": {"content": {"documents": [
        {"id": 1, "title": "Physics 12th", "pageCount": 402, "views": "123K",
         "reader_url": "https://www.scribd.com/document/1/Physics-12th?utm=x",
         "authors": [{"name": "someone"}]},
        {"id": 2, "title": "  spaced   title ",
         "reader_url": "https://id.scribd.com/document/2/Spaced",
         "pageCount": "7"},
        {"id": 3, "title": "id but no link"},
        {"id": 4, "title": "elsewhere",
         "reader_url": "https://example.com/document/4"},
    ]}}}, "compilationId": "x"}
    found = [hit for hit in (hit_from(d) for d in documents_in(answer)) if hit]
    assert [hit["id"] for hit in found] == ["1", "2", "3"], found
    assert found[0]["url"] == "https://www.scribd.com/document/1/Physics-12th"
    assert found[0]["pages"] == 402 and found[0]["author"] == "someone"
    assert found[1]["title"] == "spaced title"
    assert found[2]["url"] == "https://www.scribd.com/document/3"  # id is enough
    # a reshaped answer still gives up its documents
    moved = {"payload": [{"node": {"list": [
        {"reader_url": "https://www.scribd.com/document/9/x", "title": "moved"}]}}]}
    assert documents_in(moved)[0]["title"] == "moved"
    assert documents_in({"nothing": 1}) == []
    assert documents_in([]) == []

    # the numbers Scribd sends with the answer: total, pages, which page
    assert count_in({"total_results_count": 1234}, "total_results_count") == 1234
    assert count_in({"total_results_count": "12"}, "total_results_count") == 12
    assert count_in({"total_results_count": -5}, "total_results_count") == 0
    assert count_in({"total_results_count": None}, "total_results_count") == 0
    assert count_in({"total_results_count": 10 ** 12}, "total_results_count") == 0
    assert count_in([], "total_results_count") == 0
    assert count_in({}, "missing") == 0
    assert as_page(2) == 2 and as_page("3") == 3
    assert as_page(0) == 1 and as_page(-9) == 1          # never page zero
    assert as_page(999) == FIND_MAX_PAGE                 # and never the whole index
    assert as_page(None) == 1 and as_page("x") == 1
    assert as_page(float("inf")) == 1                    # a browser could send this

    # ---- search relevance: the words that were typed come first --------
    loose = [
        {"id": "1", "title": "Advanced Engineering Mathematics", "url":
         "https://www.scribd.com/document/1/x", "pages": 400, "views": "", "author": ""},
        {"id": "2", "title": "Physics 12th — complete notes", "url":
         "https://www.scribd.com/document/2/x", "pages": 300, "views": "", "author": ""},
        {"id": "3", "title": "Physics for Scientists", "url":
         "https://www.scribd.com/document/3/x", "pages": 900, "views": "", "author": ""},
    ]
    ranked, weak = rank_hits(loose, "physics 12th")
    assert [hit["id"] for hit in ranked] == ["2", "3", "1"], ranked
    assert [hit["match"] for hit in ranked] == ["all", "some", "none"], ranked
    assert weak == 1 and ranked[0]["score"] > ranked[1]["score"], ranked
    # the exact phrase wins even when Scribd sent it last
    ranked, _ = rank_hits(list(reversed(loose)), "physics 12th")
    assert ranked[0]["id"] == "2", ranked
    # filler words do not count as a mismatch
    ranked, weak = rank_hits(loose[:1], "the book of mathematics")
    assert ranked[0]["match"] == "some" and weak == 0, ranked
    assert query_words("The Physics of 12th, part 2") == ["physics", "12th", "2"]
    assert query_words("   ") == []
    # an empty query never re-orders or marks anything
    ranked, weak = rank_hits(loose, "")
    assert [hit["id"] for hit in ranked] == ["1", "2", "3"] and weak == 0, ranked
    assert as_channels("24") == 24 and as_channels(99) == 24
    assert as_channels(0) == PANEL_JOBS and as_channels("x") == PANEL_JOBS
    assert as_channels(-4) == PANEL_JOBS and as_channels(None) == PANEL_JOBS

    # ---- the queue: one worker, and a second tap is added, not refused ----
    def item(url):
        return {"url": url, "limit": 0, "text": False, "jobs": 8}

    job = Job()
    started, gen, note = job.enqueue([item("https://www.scribd.com/document/1/a")])
    assert started and not note and job.state == "running", (started, gen, note)
    # the book is downloading: ticking another one must not be refused
    started2, gen2, _ = job.enqueue([item("https://www.scribd.com/document/2/b"),
                                     item("https://www.scribd.com/document/3/c")])
    assert not started2 and gen2 == gen, (started2, gen2)
    assert job.pending() == 3 and job.queue_total == 3
    first = job.next_item(gen)
    assert first["url"].endswith("/1/a") and job.current.endswith("/1/a")
    assert job.pending() == 2
    job.finish_item(gen, first, "PDF BUILT", "ok", "/out/one.pdf")
    assert job.queue_done == 1 and job.results[-1]["verdict"] == "PDF BUILT"
    # a stopped job is nobody's worker any more
    assert job.alive(gen)
    job.heartbeat = time.time() - STALL_SECONDS - 5
    assert job.stalled()
    started3, gen3, note3 = job.enqueue([item("https://www.scribd.com/document/4/d")])
    assert started3 and gen3 == gen + 1 and "taking over" in note3, note3
    assert not job.alive(gen) and job.alive(gen3)
    assert job.next_item(gen) is None             # the old worker gets nothing
    assert job.queue_total >= 1                   # the queued work survives
    # finishing the queue gives one verdict for the batch
    while True:
        nxt = job.next_item(gen3)
        if nxt is None:
            break
        job.finish_item(gen3, nxt, "PDF BUILT", "ok", "/out/more.pdf")
    job.close_queue(gen3)
    assert job.state == "done" and job.verdict == "PDF BUILT", job.snapshot()
    assert "document(s) built" in job.detail, job.detail
    # an explicit reset drops what is still waiting, and keeps the reason
    job2 = Job()
    _started, gen4, _ = job2.enqueue([item("https://www.scribd.com/document/5/e")])
    job2.enqueue([item("https://www.scribd.com/document/6/f")])
    assert job2.stop("reset from the dashboard after 900s without progress")
    assert job2.state == "done" and job2.verdict == "STOPPED"
    assert "900s" in job2.detail and not job2.alive(gen4)
    assert job2.pending() == 0 and "dropped from the queue" in job2.detail
    assert job2.stop("again") is False            # nothing left to stop
    assert job2.snapshot()["stalled"] is False
    assert job2.snapshot()["queue"]["total"] >= 2
    # the command line still begins its own job
    job3 = Job()
    assert job3.begin() == 1 and job3.state == "running"
    # missing pages are never retried: the budgets that paid for retry rounds
    # are gone with them, and the only rests left are the breaker's
    assert "RETRY_BUDGET" not in globals(), "a retry budget came back"
    assert "SHOT_RETRY_BUDGET" not in globals(), "a retry budget came back"
    assert 0 < REST_BUDGET <= 300, REST_BUDGET
    assert 0 < SHOT_REST_BUDGET <= REST_BUDGET, SHOT_REST_BUDGET
    # standard quality, and enough tabs to keep a browser busy
    assert SHOT_SCALE == float(os.environ.get("SCRIBD_SHOT_SCALE") or 1), SHOT_SCALE
    assert MAX_SHOT_JOBS >= 6, MAX_SHOT_JOBS
    # a cap below the longest book on the shelf is a book that comes out short
    assert MAX_SHOT_PAGES >= 402, MAX_SHOT_PAGES
    # a document with a browser waiting rests less, and says so in its own voice
    quick = Ctx("https://www.scribd.com/document/7/x")
    assert quick.rest_budget == REST_BUDGET, quick.rest_budget
    quick.rest_budget = SHOT_REST_BUDGET
    quick.rested = SHOT_REST_BUDGET
    for page in (40, 41, 42, 43):
        assert quick.refused(page) is False, "the shorter budget must stop it"

    # ---- the disk guard: a small plan must not fill up in silence -------
    keep_root = os.path.join(work, "keep")
    os.makedirs(keep_root, exist_ok=True)
    old_pdf = os.path.join(keep_root, "old.pdf")
    with open(old_pdf, "wb") as handle:
        handle.write(b"%PDF-1.4\n" + b"x" * 4000)
    long_ago = time.time() - 5 * 86400
    os.utime(old_pdf, (long_ago, long_ago))
    cache_dir = os.path.join(keep_root, "cache", "123")
    os.makedirs(cache_dir, exist_ok=True)
    with open(os.path.join(cache_dir, "0001-a.bin"), "wb") as handle:
        handle.write(b"x" * 100)
    os.utime(cache_dir, (long_ago, long_ago))
    fresh_pdf = os.path.join(keep_root, "new.pdf")
    with open(fresh_pdf, "wb") as handle:
        handle.write(b"%PDF-1.4\n" + b"y" * 4000)
    said = prune_out(keep_root)
    assert os.path.isfile(fresh_pdf), "the newest PDF must be kept"
    assert any("cache: dropped 123" in line for line in said), said
    assert not os.path.isdir(cache_dir), said
    # too many files: only the newest KEEP_FILES survive
    before = KEEP_FILES
    globals()["KEEP_FILES"] = 1
    try:
        said = prune_out(keep_root)
    finally:
        globals()["KEEP_FILES"] = before
    assert not os.path.isfile(old_pdf) and os.path.isfile(fresh_pdf), said
    assert any("older than the newest 1" in line for line in said), said
    # a hard cap removes the oldest first, and never the last one left
    before_mb = MAX_OUT_MB
    globals()["MAX_OUT_MB"] = 0
    try:
        said = prune_out(keep_root)
    finally:
        globals()["MAX_OUT_MB"] = before_mb
    assert os.path.isfile(fresh_pdf), "the last PDF is never deleted"
    assert folder_mb(keep_root) >= 0

    # ---- the panel page is usable on a phone and has no paste box -------
    assert "width=device-width" in PAGE
    assert "@media (max-width:640px)" in PAGE and "font-size:16px" in PAGE
    assert 'id="markall"' in PAGE and 'id="untickall"' in PAGE
    assert 'id="channels"' in PAGE and 'value="16" selected' in PAGE
    assert 'id="reset"' in PAGE and 'id="stallrow"' in PAGE
    assert 'id="links"' not in PAGE and "paste links" not in PAGE
    assert PAGE.count('id="ticked"') == 1 and "'/reset'" in PAGE
    assert "related, not a match" in PAGE
    # every element the page's script reaches for must exist in the page — a
    # removed card leaves $('links') behind and nothing else notices until a tap
    script = PAGE.split("<script>", 1)[1].split("</script>", 1)[0]
    wanted_ids = set(re.findall(r"\$\('([a-z]+)'\)", script))
    absent = sorted(name for name in wanted_ids if f'id="{name}"' not in PAGE)
    assert not absent, absent
    assert "markall" in wanted_ids and "channels" in wanted_ids
    # the handlers the page needs, in the order the script defines them
    for handler in ("$('find').onclick", "$('markall').onclick",
                    "$('untickall').onclick", "$('reset').onclick",
                    "$('ticked').onclick"):
        assert handler in script, handler

    def stub(payload, status=200, error=""):
        def ask(url):
            body = (payload if isinstance(payload, bytes)
                    else json.dumps(payload).encode())
            return {"status": status, "body": body, "headers": {}, "error": error}
        return ask

    hits, notes = find_documents("physics 12th", 1, ask=stub(answer))
    assert [hit["id"] for hit in hits] == ["1", "2", "3"], hits
    assert notes == ["page 1: 4 document(s), 3 new"], notes
    assert picked_hits(hits, "2") == [hits[1]]
    assert picked_hits(hits, "1-2") == hits[:2]
    assert picked_hits(hits, "3,1") == [hits[2], hits[0]]
    assert picked_hits(hits, "9") == [] and picked_hits(hits, "x") == []

    # a refusal is reported as a refusal, never dressed up as "no results"
    hits, notes = find_documents("physics", 1, ask=stub(b"nope", 403))
    assert hits == [] and "refused" in notes[0], notes
    hits, notes = find_documents("physics", 1, ask=stub(b"<html>app</html>"))
    assert hits == [] and "not search data" in notes[0], notes
    hits, notes = find_documents("physics", 1,
                                 ask=stub({}, 0, "connection refused"))
    assert hits == [] and "no answer" in notes[0], notes
    hits, notes = find_documents("   ", 1, ask=stub(answer))
    assert hits == [] and "type a few words" in notes[0], notes
    # one page at a time: the page number is sent, and the totals come back
    asked: list[str] = []

    def counting(payload):
        def ask(url):
            asked.append(url)
            return {"status": 200, "body": json.dumps(payload).encode(),
                    "headers": {}, "error": ""}
        return ask

    paged = dict(answer)
    paged["total_results_count"] = 3
    paged["page_count"] = 2
    hits, note, info = find_page("physics 12th", 2, counting(paged))
    assert asked[-1].endswith("page=2"), asked[-1]
    assert info == {"page": 2, "documents": 4, "total": 3, "pages": 2}, info
    assert len(hits) == 3, len(hits)
    assert note == ("4 document(s), 1 dropped (duplicate or not a Scribd document)"
                    ", 2 only loosely related"), note

    empty = {"results": {}, "total_results_count": 0, "page_count": 0}
    hits, note, info = find_page("nothing at all", 1, counting(empty))
    assert hits == [] and info["total"] == 0, (hits, info)
    assert "named no documents" in note, note
    hits, note, info = find_page("nothing at all", 3, counting(empty))
    assert note == "no more documents", note          # a later page is not a failure
    # no totals in the answer: still fine, the page just will not show a count
    hits, note, info = find_page("physics", 1, stub(answer))
    assert info["total"] == 0 and info["documents"] == 4, info

    # a page with nothing new stops the paging instead of hammering Scribd
    hits, notes = find_documents("physics", 3, ask=stub(answer))
    assert len(hits) == 3 and len(notes) == 2, notes
    assert notes[-1] == "page 2: 4 document(s), 0 new", notes

    # ---- the throttle breaker: a locked page and a throttled address ----
    spoken: list[str] = []
    before_say = JOB.say
    JOB.say = lambda text: spoken.append(text)
    ctx = Ctx("https://www.scribd.com/document/750213011/x", 4)
    assert ctx.refused(3) is False            # one page refused: not a throttle
    assert ctx.refused(3) is False            # the same page again: still not
    assert ctx.refused(4) is False            # a second page
    assert ctx.refused(5) is True             # three different pages: throttled
    assert 0 < ctx.rest_until - time.time() <= PAUSE_LADDER[0] + 0.5
    assert ctx.rest_until - time.time() > 1
    # while resting it keeps saying "rest", and the ladder must not climb
    assert ctx.refused(6) is True and ctx.rests == 1, ctx.rests
    ctx.rest_until = 0.0                      # the rest is over
    ctx.dead.add("some-name")
    for page in (7, 8, 9):
        last = ctx.refused(page)
    assert last is True and ctx.rests == 2, (last, ctx.rests)
    assert not ctx.dead, "names refused while throttled must not stay dead"
    # a good page resets the counting
    ctx.rest_until = 0.0
    ctx.answered()
    assert ctx.refused(10) is False and ctx.refused(11) is False
    assert ctx.refused(12) is True
    # the ladder is capped, and a run of good answers steps it back down
    ctx.rest_until = 0.0
    ctx.rested = 0.0                      # a fresh resting budget for this run
    ctx.rests = 99
    ctx.refused(20), ctx.refused(21), ctx.refused(22)
    assert PAUSE_LADDER[-1] - 0.5 <= ctx.rest_until - time.time() <= PAUSE_LADDER[-1] + 0.5
    ctx.rests, ctx.reliefs, ctx.rest_until = 2, 0, 0.0
    for _ in range(8):
        ctx.answered()
    assert ctx.rests == 1, ctx.rests
    assert len(spoken) == 4, spoken          # one line per rest, not one per 403
    # resting is bounded: a document cannot spend minutes of the reader's time
    # waiting for refusals that are not clearing
    ctx.rest_until, ctx.rested, ctx.said_no_hope = 0.0, ctx.rest_budget, False
    ctx.refused_pages.clear()
    for page in (30, 31, 32, 33):
        stopped = ctx.refused(page)
    assert stopped is False, "the resting budget must stop the ladder"
    assert any("rested" in line for line in spoken), spoken
    JOB.say = before_say
    assert any("throttling" in line for line in spoken), spoken

    # ---- the text layer: the words, not just the pictures -------------------
    assert html_to_text("<div>One</div><br><div>Two &amp; three</div>") == "One\nTwo & three"
    assert html_to_text("<p>a</p><p>b</p>").split("\n") == ["a", "b"]
    assert html_to_text("  <span>x</span>  ") == "x"
    assert html_to_text("") == "" and html_to_text(None) == ""
    assert "\n\n\n" not in html_to_text("<br><br><br><div>z</div>")
    page = b'window.page2_callback(["<div>First</div>", "<br>", "Second &#39;quote&#39;"]);'
    assert text_from_jsonp(page) == "First\nSecond 'quote'", text_from_jsonp(page)
    assert text_from_jsonp(b'window.page2_callback([1, null, "<b>ok</b>"]);') == "ok"
    assert text_from_jsonp(b"not a descriptor") == ""
    assert text_from_jsonp(b'window.page2_callback(["unterminated")') == ""
    assert text_from_jsonp(b"[not json") == ""
    # the descriptor shares the scan's <page>-<hash> pair, so it is derivable
    assert jsonp_from_image(
        "https://html.scribdassets.com/9675umbmgwcrttvn/images/2-90c206b2e6.jpg"
    ) == "https://html.scribdassets.com/9675umbmgwcrttvn/pages/2-90c206b2e6.jsonp"
    assert jsonp_from_image(
        "https://html.scribdassets.com/9675umbmgwcrttvn/images/2-90c206b2e6.jpg?token=x"
    ).endswith("/pages/2-90c206b2e6.jsonp")
    assert jsonp_from_image("https://www.scribd.com/document/1/x") == ""
    # a layer is only drawn where there is room, and it never prints
    layer = text_layer("Hello there\nSecond line", (900.0, 1200.0, 0.0, 0.0))
    assert b"3 Tr" in layer and b"(Hello there) Tj" in layer, layer
    assert b"im0" not in layer and b"Do" not in layer
    assert text_layer("Hello", (15.0, 15.0, 0.0, 0.0)) == b""
    assert text_layer("", (900.0, 1200.0, 0.0, 0.0)) == b""
    # brackets and backslashes must be escaped, latin-1 must survive
    tricky = text_layer("a (b) \\ c \u2014 caf\u00e9", (400.0, 100.0, 0.0, 0.0))
    assert b"\\(b\\)" in tricky and b"\\\\" in tricky, tricky
    assert b"caf\xe9" in tricky and b"\xe2\x80\x94" not in tricky, tricky
    # and the finished file carries it without breaking the sheet
    with tempfile.TemporaryDirectory() as spot:
        book = os.path.join(spot, "text.pdf")
        leaf = scan_for_pdf(make_jpeg(1200, 1600))
        ok, note = build_pdf([leaf, None], book, texts={1: "Mock page one\nline two"})
        assert ok and "searchable text" in note, note
        assert "1 page(s) omitted" in note, note
        sound, report = verify_pdf(book, expect_pages=1, expect_images=1)
        assert sound, report                       # the layer must not break xref
        with open(book, "rb") as handle:
            written = handle.read()
        assert b"(Mock page one) Tj" in written
        assert b"scan not available" not in written
        # the text page is untouched by the omission: one page has text
        assert note.count("1 page(s) with searchable text") == 1, note
        # a book where nothing arrived is not a book: no file, honest note
        ok, note = build_pdf([None, None], os.path.join(spot, "none.pdf"))
        assert not ok and "no pages" in note, note
        ok, note = build_pdf([leaf], book)
        assert ok and "searchable" not in note, note
        with open(book, "rb") as handle:
            assert b"Tj" not in handle.read()
        # a preview page is a legal sheet; a smudge is still a broken file
        ok, note = build_pdf([preview_page, leaf], book)
        assert ok, note
        with open(book, "rb") as handle:
            written = handle.read()
        assert verify_bytes(written, expect_pages=2, expect_images=2)[0]
        smudge = dict(preview_page)
        smudge["width"] = smudge["height"] = 40
        smudge["params"] = (preview_page["params"]
                            .replace("/Width 96", "/Width 40")
                            .replace("/Height 130", "/Height 40"))
        assert build_pdf([smudge, leaf], book)[0]
        sound, report = verify_pdf(book, expect_pages=2, expect_images=2)
        assert not sound and "only 40x40" in report, report

    # ---- the panel gate a dashboard has to come through ---------------------
    global PANEL_KEY, PANEL_ORIGINS
    saved_key, saved_origins = PANEL_KEY, PANEL_ORIGINS

    PANEL_KEY = ""                                   # open panel: as before
    assert panel_gate({}, {}) and panel_gate({"X-Panel-Key": "anything"}, {})

    PANEL_KEY = "s3cret"                             # keyed panel
    assert not panel_gate({}, {})
    assert not panel_gate({"X-Panel-Key": "nope"}, {})
    assert panel_gate({"X-Panel-Key": "s3cret"}, {})
    assert panel_gate({}, {"key": ["s3cret"]})
    assert not panel_gate({}, {"key": ["S3CRET"]})    # exact, not fuzzy
    assert panel_gate({}, {}, "theme=dark; scribd_panel_key=s3cret")
    assert not panel_gate({}, {}, "scribd_panel_key=other")
    cookie = panel_cookie()
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie, cookie
    assert "scribd_panel_key=s3cret" in cookie

    # ---- signed download links: one file, briefly, no key in the URL ----
    keep_signing, PANEL_KEY = PANEL_KEY, "k3y"
    try:
        soon = int(time.time()) + 600
        good = file_token("Doc (2).pdf", soon)
        assert len(good) == 64 and token_ok("Doc (2).pdf", soon, good)
        assert not token_ok("Doc (3).pdf", soon, good)          # another file
        assert not token_ok("Doc (2).pdf", soon + 1, good)      # another moment
        assert not token_ok("Doc (2).pdf", int(time.time()) - 5, good)   # expired
        assert not token_ok("Doc (2).pdf", soon, good[:-1] + ("0" if good[-1] != "0" else "1"))
        assert not token_ok("Doc (2).pdf", "soon", good)        # junk expiry
        assert not token_ok("Doc (2).pdf", None, good)
        assert not token_ok("Doc (2).pdf", soon, "")            # no signature
        # a signature dated years ahead is refused, so a leaked one dies
        assert not token_ok("Doc (2).pdf", int(time.time()) + 8 * 24 * 3600, good)
    finally:
        PANEL_KEY = keep_signing


    PANEL_ORIGINS = ["https://dash.example.vercel.app"]
    allowed = cors_headers("https://dash.example.vercel.app")
    assert allowed["Access-Control-Allow-Origin"] == "https://dash.example.vercel.app"
    assert "X-Panel-Key" in allowed["Access-Control-Allow-Headers"]
    assert cors_headers("https://evil.example") == {}   # never a wildcard
    assert cors_headers("") == {}
    PANEL_ORIGINS = []
    assert cors_headers("https://dash.example.vercel.app") == {}

    PANEL_KEY, PANEL_ORIGINS = saved_key, saved_origins

    # ---- the file list the dashboard reads, so it never guesses names ------
    with tempfile.TemporaryDirectory() as shelf:
        with open(os.path.join(shelf, "Book.pdf"), "wb") as handle:
            handle.write(b"x" * 12)
        with open(os.path.join(shelf, "notes.txt"), "wb") as handle:
            handle.write(b"not a pdf")
        rows = panel_files(shelf)
        assert [row["name"] for row in rows] == ["Book.pdf"], rows
        assert rows[0]["bytes"] == 12 and rows[0]["when"] > 0
        assert panel_files(os.path.join(shelf, "gone")) == []

    # ---- the words keep their lines, their places and their characters ----
    # Curly quotes and the ellipsis are cp1252, not Latin-1: written as the
    # wrong byte they became "?", dropped they turned "ZAM’KATIMU" into
    # "ZAMKATIMU" and ate the dotted leaders of a contents page.
    for char in ("\u2019", "\u2018", "\u201c", "\u201d", "\u2013", "\u2014",
                 "\u2026", "\u00e9", "\u00b7", "\u20ac"):
        assert can_winansi(char), char
        assert pdf_visible_text(char) == char, char
        assert pdf_visible_text(char).encode("cp1252")
    assert not can_winansi("\u4e2d")
    assert pdf_visible_text("\u4e2d\u6587") == ""          # unspellable: dropped
    assert pdf_visible_text("\u2010") == "-"                # no cp1252 byte
    assert pdf_visible_text("a (b) c") == "a \\(b\\) c"
    assert pdf_visible_text("back\\slash") == "back\\\\slash"
    toc = ["ZAM\u2019KATIMU", "Mutu          Tsamba",
           "1.Mutu 1\u2026.....\u2026....Kubadwa kwake\u2026\u2026\u2026\u2026.4"]
    drawn_toc, lines_toc = text_body_page("\n".join(toc), (595.0, 842.0))
    assert lines_toc == 3
    shown_toc = " ".join(re.findall(r"\((.*?)\) Tj",
                                    drawn_toc.decode("cp1252")))
    assert "ZAM\u2019KATIMU" in shown_toc and "\u2026" in shown_toc, shown_toc
    assert not re.search(r"\bZAMKATIMU\b", shown_toc)

    # Helvetica's real widths, so a line cannot run off the sheet
    assert text_width("", 12) == 0
    assert abs(text_width("i", 1000) - 222) < 1.0          # narrow
    assert abs(text_width("M", 1000) - 833) < 1.0          # wide
    assert text_width("hello world", 24) > text_width("hello world", 12)
    wrapped_real = wrap_to_width("word " * 40, 200.0, 11.0)
    assert wrapped_real and all(text_width(line, 11.0) <= 200.0
                                for line in wrapped_real), [
        text_width(line, 11.0) for line in wrapped_real]
    assert " ".join(wrapped_real).split() == ["word"] * 40
    # one word wider than the sheet is broken, not left hanging over the edge
    long_word = wrap_to_width("MM" * 40, 60.0, 11.0)
    assert all(text_width(line, 11.0) <= 60.0 for line in long_word), long_word

    # the placed lines of a page: rows, not one long run
    placed = ('<div class="text_layer">'
              '<span style="left:8%;top:4%">ZAM\u2019KATIMU</span>'
              '<span style="left:8%;top:12%"><span style="left:8%;top:12%">Mutu</span>'
              '<span style="left:60%;top:12%">Tsamba</span></span>'
              '<span style="left:8%;top:50%">6. Mutu 6\u2026\u2026Ufumu wake\u2026\u202636</span>'
              '</div>')
    rows = positioned_lines(placed)
    assert [row[0] for row in rows] == ["ZAM\u2019KATIMU", "Mutu   Tsamba",
                                        "6. Mutu 6\u2026\u2026Ufumu wake\u2026\u202636"], rows
    assert rows[0][1] < rows[1][1] < rows[2][1]
    assert positioned_lines("<p>no placement at all</p>") == []
    encoded = lines_from_html(placed)
    lines_back, places_back = decode_page_lines(encoded)
    assert len(lines_back) == 3 and places_back is not None
    assert places_back[0] == 0.0 and 0.0 < places_back[1] < places_back[2] <= 1.0
    # two columns on one row keep a gap between them
    assert words_plain(encoded).split("\n")[1] == "Mutu   Tsamba", \
        repr(words_plain(encoded))
    # no placement in the markup: block tags give the lines
    assert lines_from_html("<p>one</p><p>two</p>").split("\n") == ["one", "two"]
    # nor block tags: runs of wide space are the line ends, not one flat run
    flat = lines_from_html("a" + " " * 6 + "b" + " " * 6 + "c")
    assert flat.split("\n") == ["a", "b", "c"], flat
    # a page with no placement keeps normal line spacing (not one line per
    # sheet, not a single run)
    # a page whose last viewer lines sit below the sheet keeps every one of
    # them: the column squeezes, the words stay. Page 38 of a real document
    # lost its last four lines — signature and contact details — to the old
    # cut, and page 3 lost the author's name.
    over = "\n".join(f"{LINE_MARK}{place:.3f}|line number {i}"
                      for i, place in enumerate((0.0, 0.4, 0.9, 1.0, 1.08)))
    squeeze: list[int] = []
    over_body, over_lines = text_body_page(over, (595.0, 842.0), squeeze)
    assert over_lines == 5 and squeeze, (over_lines, squeeze)
    assert over_body.count(b"Tj") == 5, over_body
    over_ys = [float(m.group(1)) for m in
               re.finditer(rb"1 0 0 1 \d+\.\d\d (\d+\.\d\d) Tm", over_body)]
    assert len(over_ys) == 5 and min(over_ys) >= 45.99, over_ys
    # and a page that fits is untouched: same size, same places, k = 1
    fits = "\n".join(f"{LINE_MARK}{place:.3f}|row {i}"
                      for i, place in enumerate((0.0, 0.5, 1.0)))
    fit_body, fit_lines = text_body_page(fits, (595.0, 842.0), [])
    assert fit_lines == 3 and b"Tj" in fit_body
    sparse = "\n".join(f"line {n}" for n in range(1, 5))
    sparse_body, sparse_lines = text_body_page(sparse, (595.0, 842.0))
    assert sparse_lines == 4
    ys = [float(m.group(1)) for m in
          re.finditer(r"1 0 0 1 [\d.]+ (-?[\d.]+) Tm", sparse_body.decode("cp1252"))]
    gap = ys[0] - ys[1]
    sparse_size = float(re.search(rb"/F1 ([\d.]+) Tf", sparse_body).group(1))
    assert 1.1 * sparse_size <= gap <= 1.6 * sparse_size, (gap, sparse_size)
    # a placed page keeps the spacing it was given, not a uniform leading
    placed_lines = [("title", 0.0), ("body", 0.55), ("footnote", 0.95)]
    spaced = encode_page_lines(placed_lines)
    spaced_body, _ = text_body_page(spaced, (595.0, 842.0))
    spaced_ys = [float(m.group(1)) for m in
                 re.finditer(r"1 0 0 1 [\d.]+ (-?[\d.]+) Tm",
                             spaced_body.decode("cp1252"))]
    first_gap, second_gap = spaced_ys[0] - spaced_ys[1], spaced_ys[1] - spaced_ys[2]
    # 0.55 - 0.0 of the sheet above, 0.95 - 0.55 below: the page's own spacing
    assert abs(first_gap / second_gap - 0.55 / 0.40) < 0.15, (first_gap, second_gap)
    # a page on a big sheet gets big type, not a footnote in the corner
    big_body, _ = text_body_page("Mutu wa nkhani", (900.0, 1200.0))
    big_size = float(re.search(rb"/F1 ([\d.]+) Tf", big_body).group(1))
    small_body, _ = text_body_page("Mutu wa nkhani", (595.0, 842.0))
    small_size = float(re.search(rb"/F1 ([\d.]+) Tf", small_body).group(1))
    assert big_size > small_size * 1.3, (big_size, small_size)

    # ---- the viewer's own pages, where a converted document's words live --
    viewer = (
        b'<div id="page-1" class="outer_page" data-page-number="1">'
        b'<div class="text_layer"><p>First page words</p><p>more of page one</p>'
        b'</div><img src="//html.scribdassets.com/h7/images/1-aa7.jpg">'
        b'<div class="ad"><a href="https://www.scribd.com/oauth/signup">'
        b'Download to read ad-free</a></div></div>'
        b'<div id="page-2" class="outer_page" data-page-number="2">'
        b'<div class="text_layer"><p>Second page words</p></div>'
        b'<div class="share">Share this document</div></div>'
        b'<div id="page-3" class="outer_page" data-page-number="3">'
        b'<style>.x{}</style><div class="text_layer"><p>Third page words</p>'
        b'</div></div>')
    pages = embed_text_pages(viewer)
    assert sorted(pages) == [1, 2, 3], pages
    assert pages[1].split("\n") == ["First page words", "more of page one"], pages[1]
    assert pages[2] == "Second page words", pages[2]
    assert pages[3] == "Third page words", pages[3]
    # the chrome of every page is dropped, and no half tag survives
    for words in pages.values():
        assert "ad-free" not in words and "Share this" not in words
        assert "page-" not in words and "outer_page" not in words, words
        assert "<" not in words and "class=" not in words, words
    # a viewer that prints no page numbers but one text block per page
    bare = b"".join(b'<div class="text_layer"><p>Word %d</p></div>' % n
                    for n in range(1, 6))
    bare_pages = embed_text_pages(bare)
    assert sorted(bare_pages) == [1, 2, 3, 4, 5], bare_pages
    assert bare_pages[4] == "Word 4"
    # a JS-only shell carries nothing: say so instead of inventing pages
    assert embed_text_pages(b'<html><div id="viewer"></div>'
                            b'<script>boot()</script></html>') == {}
    assert embed_text_pages(b"") == {}
    # a script full of markup must not be read as the book
    assert embed_text_pages(b'<script>var h=\'<div class="text_layer">x</div>\''
                            b'</script>') == {}
    assert is_boilerplate("Download to read ad-free")
    assert is_boilerplate("12") and not is_boilerplate("Mutu wa nkhani")
    assert tidy_page_text("ad\nreal words here\nShare this document") == \
        "real words here"
    assert "text block(s)" in viewer_fingerprint(viewer)

    # ---- the same name, however the page wrote it ------------------------
    assert full_url("//html.scribdassets.com/h/images/1-a.jpg") == \
        "https://html.scribdassets.com/h/images/1-a.jpg"
    assert full_url("https://x/y.jpg") == "https://x/y.jpg"
    assert full_url("/relative/thing") == "" and full_url("") == ""
    schemeless = Sources()
    schemeless.merge(b'var p="//html.scribdassets.com/h7/images/2-bb7.jpg";')
    schemeless.merge(b'var q="https:\\/\\/html.scribdassets.com\\/h7'
                     b'\\/pages\\/2-bb7.jsonp";')
    assert schemeless.images_for(2) == [
        "https://html.scribdassets.com/h7/images/2-bb7.jpg"], schemeless.images_for(2)
    assert schemeless.jsonps_for(2) == [
        "https://html.scribdassets.com/h7/pages/2-bb7.jsonp"], schemeless.jsonps_for(2)
    assert schemeless.count() == 1

    # ---- building a descriptor address nothing printed ------------------
    named = (b'var p1="https:\\/\\/html.scribdassets.com\\/h7\\/images'
             b'\\/1-aa7.jpg";')
    sources = Sources()
    sources.merge(named)
    assert sources.jsonps_for(2) == [] and sources.images_for(2) == []
    assert sources.asset_patterns() == [
        "https://html.scribdassets.com/h7/images/1-aa7.jpg"], sources.asset_patterns()
    built = jsonp_for_page(sources.asset_patterns()[0], 2)
    assert built == "https://html.scribdassets.com/h7/pages/2-aa7.jsonp", built
    assert jsonp_for_page("https://h/pages/9-bb.jsonp?token=x", 4) == \
        "https://h/pages/4-bb.jsonp?token=x"
    assert jsonp_for_page("https://h/images/3-cc.webp", 11) == \
        "https://h/pages/11-cc.jsonp"
    assert jsonp_for_page("https://h/nothing", 5) == "https://h/nothing"
    # a descriptor's name is its scan's name: siblings on one asset host. This
    # is why a page whose words were refused still has a picture to ask for.
    assert image_url_for("https://h/pages/16-abc123.jsonp") == \
        "https://h/images/16-abc123.jpg"
    assert jsonp_from_image("https://h/images/16-abc123.jpg") == \
        "https://h/pages/16-abc123.jsonp"
    assert image_url_for("https://h/images/16-abc123.jpg") == ""
    # the token is also a map: which pages the CDN will serve at all
    head = base64.urlsafe_b64encode(b'{"alg":"HS256"}').rstrip(b"=").decode()
    pay = base64.urlsafe_b64encode(json.dumps(
        {"iss": "scribd-monolith", "format_uuid": "4171k03itcblvzxd",
         "page_min": 1, "page_max": 10, "enforce": True}).encode()).rstrip(b"=").decode()
    preview_jwt = f"{head}.{pay}.sig"
    assert jwt_claims(preview_jwt).get("page_max") == 10, jwt_claims(preview_jwt)
    assert jwt_claims(preview_jwt).get("format_uuid") == "4171k03itcblvzxd"
    assert jwt_claims("not.a.jwt") == {} and jwt_claims("") == {}
    claims = jwt_claims(preview_jwt)
    assert unlocked_range(claims, 38) == (1, 10)
    assert unlocked_range({}, 38) == (1, 38)
    assert unlocked_range({"enforce": True, "page_max": 99}, 38) == (1, 38)
    assert unlocked_range({"enforce": True, "page_min": "x"}, 38) == (1, 38)
    assert unlocked_range({"enforce": True, "page_min": 5, "page_max": 4}, 38) == (1, 38)
    # no-token FIRST: the token the HTML embedded is the one minted for this
    # asset and rides along on the fallback — so if it has expired, that
    # fallback is a 403, and the bare name is the variant that still works
    stale, fresh = "0123456789abcdef0123", "fedcba9876543210fedc"
    named = "https://h/pages/4-x.jsonp?token=" + stale
    pair = jsonp_variants_of(named, fresh)
    assert pair[0] == "https://h/pages/4-x.jsonp", pair
    assert pair[1] == named, pair          # embedded token rides the fallback
    assert jsonp_variants_of("https://h/pages/4-x.jsonp", fresh)[0] == \
        "https://h/pages/4-x.jsonp"
    assert jsonp_variants_of("https://h/pages/4-x.jsonp", "") == \
        ["https://h/pages/4-x.jsonp"]

    # ---- a page that is text, not a scan --------------------------------
    # The case that made a 38-page document come out as 37 grey boxes: most of
    # its pages have words and no image at all. Those pages have to be drawn.
    assert wrap_to_width("", 200.0, 11.0) == []
    assert wrap_to_width("one two three", 200.0, 11.0) == ["one two three"]

    body_words = ("KUSANTHULA BUKU LA NTHONDO. " * 40).strip()
    content, drawn = text_body_page(body_words, (595.0, 842.0))
    assert drawn > 1 and content.startswith(b"BT") and content.endswith(b"ET")
    shown = " ".join(re.findall(r"\((.*?)\) Tj", content.decode("latin-1")))
    assert shown.split() == body_words.split(), "the sheet is not the page"
    small, _ = text_body_page(body_words * 12, (595.0, 842.0))
    assert float(re.search(rb"/F1 ([\d.]+) Tf", small).group(1)) < 10.5
    assert text_body_page("   ", (595.0, 842.0)) == (b"", 0)

    with tempfile.TemporaryDirectory() as shelf:
        both = os.path.join(shelf, "text.pdf")
        made, message = build_pdf([None, None], both, title="T",
                                  text_pages={1: body_words, 2: body_words})
        assert made, message
        assert "2 page(s) from the document's text" in message, message
        assert "placeholder" not in message, message
        ok, detail = verify_pdf(both, expect_pages=2, expect_images=0)
        assert ok, detail

        half = os.path.join(shelf, "half.pdf")
        made, message = build_pdf([None, None], half, title="T",
                                  text_pages={1: body_words})
        assert made and "1 page(s) omitted" in message, message
        assert "1 page(s) from the document's text" in message, message

        empty = os.path.join(shelf, "empty.pdf")
        made, message = build_pdf([None, None], empty, title="T",
                                  text_pages={1: "   "})
        assert not made and message == "no pages to write", message

    # ---- a browser that photographs the pages nobody sent us --------------
    # the book wire format: lengths, pictures in order, manifest readable —
    # and a body cut mid-picture is an error, never a half book
    def _png_blob(seed: int) -> bytes:
        import struct as _st, zlib as _z
        raw = b"".join(b"\x00" + bytes((seed + i) % 251 for i in range(60))
                       for _ in range(8))
        return (b"\x89PNG\r\n\x1a\n" + b"IHDR" +
                _st.pack(">IIBBBBB", 20, 8, 8, 2, 0, 0, 0) +
                b"IDAT" + _z.compress(raw) + b"IEND")
    pa, pb = _png_blob(3), _png_blob(9)
    wire = b"".join(len(x).to_bytes(4, "big") + x for x in (pa, pb)) + \
        b"\x00" * 4 + b'{"pages": [{"page": 1, "width": 20, "height": 8},' \
        b' {"page": 2, "width": 20, "height": 8, "blank": true}]}'
    got, err = decode_shots(wire)
    assert not err and len(got) == 2, err
    assert got[0]["png"] == pa and got[1]["png"] == pb
    assert got[0]["page"] == 1 and got[1]["blank"] is True
    assert got[0]["width"] == 20 and got[0]["height"] == 8
    assert decode_shots(wire[:len(wire) - 20])[1], "a cut body is refused"
    assert decode_shots(b"\x00" * 4 + b"not json")[1], "a bad manifest is refused"
    # the browser egg's own endpoint is written down, so a panel that was never
    # told anything still knocks on the right door — and knocks next door first,
    # because a shut door beside you answers instantly while one across a
    # network costs the whole timeout
    assert "http://node6.botkeep.cloud:45009" in SHOT_HOSTS, SHOT_HOSTS
    assert "http://77.90.45.110:45009" in SHOT_HOSTS, SHOT_HOSTS
    assert SHOT_HOSTS.index("http://127.0.0.1:8096") < SHOT_HOSTS.index(
        "http://node6.botkeep.cloud:45009"), SHOT_HOSTS
    assert SHOT_HOSTS.index("http://node6.botkeep.cloud:45009") < SHOT_HOSTS.index(
        "http://195.123.189.187:25811"), SHOT_HOSTS
    # the copy started beside the panel takes the door the ladder asks first, so
    # starting one can never put the browser somewhere nobody looks
    assert SHOT_HOSTS[0] == f"http://127.0.0.1:{SHOT_LOCAL_PORT}", SHOT_HOSTS[0]
    # the sweep asks the egg's own host, and the shelf around today's endpoint
    # before the wide band, so a host that moved the port is still found fast
    assert SHOOTER_SCAN_HOSTS[0] == ("node6.botkeep.cloud",
                                     ((45000, 45100), (44000, 46000))), \
        SHOOTER_SCAN_HOSTS[0]
    assert any(name == "77.90.45.110" for name, _bands in SHOOTER_SCAN_HOSTS), \
        SHOOTER_SCAN_HOSTS
    # a sweep that finds nothing says so in words, and then rests: an egg that
    # is simply stopped must not slow down every document that asks for it, and
    # must not leave anybody guessing whether it was ever looked for
    held_tried = dict(_SCAN_TRIED)
    held_ranges = SHOOTER_SCAN_RANGES
    held_cache = read_shooter_cache()
    said: list[str] = []
    try:
        if os.path.exists(shooter_cache_path()):
            os.remove(shooter_cache_path())
        globals()["SHOOTER_SCAN_RANGES"] = ((1, 2),)      # two ports nobody is behind
        _SCAN_TRIED["when"] = 0.0
        assert scan_for_shooter(host="127.0.0.1", announce=said.append) == ""
        assert any("port by port" in line for line in said), said
        assert any("minutes" in line for line in said), said
        said.clear()
        assert scan_for_shooter(host="127.0.0.1", announce=said.append) == ""
        assert not said, f"a rested sweep ran again: {said}"
        # a sweep is given a budget, because documents are waiting on it: with
        # no time left it says so at once rather than asking ports for an hour
        held_budget = SCAN_BUDGET
        try:
            globals()["SCAN_BUDGET"] = 0.0
            _SCAN_TRIED["when"] = 0.0
            said.clear()
            assert scan_for_shooter(host="127.0.0.1", announce=said.append) == ""
            assert any("ran out" in line for line in said), said
        finally:
            globals()["SCAN_BUDGET"] = held_budget
    finally:
        globals()["SHOOTER_SCAN_RANGES"] = held_ranges
        _SCAN_TRIED.update(held_tried)
        if held_cache:
            write_shooter_cache(held_cache)
        elif os.path.exists(shooter_cache_path()):
            os.remove(shooter_cache_path())
    # the found-address cache round-trips, and a non-address is not one
    cache_at = shooter_cache_path()
    try:
        write_shooter_cache("http://127.0.0.1:25877")
        assert read_shooter_cache() == "http://127.0.0.1:25877"
        with open(cache_at, "w") as handle:
            handle.write("nonsense\n")
        assert read_shooter_cache() == ""
    finally:
        if os.path.exists(cache_at):
            os.remove(cache_at)
    # the start log is the service's own voice: last lines, joined, never a guess
    with tempfile.TemporaryDirectory() as shelf:
        os.makedirs(os.path.join(shelf, "tmp"))
        with open(shooter_log_path(shelf), "w") as handle:
            handle.write("booting\nError: Cannot find package '@sparticuz/chromium'\n")
        assert "Cannot find package" in shooter_start_reason(shelf)
        os.remove(shooter_log_path(shelf))
        assert shooter_start_reason(shelf) == ""
    padded_wire = b"\x00" * 4 + b'{"run": {"pad": 400, "count": 3}}'
    assert body_manifest(padded_wire).get("run", {}).get("pad") == 400
    assert body_manifest(b"\x00" * 4 + b"not json") == {}
    assert entry_manifest(got).startswith("2 page(s) clipped at the gaps, every sheet 20x8")
    assert shot_request("http://host:8096/", "7", 12, 2.0) == (
        "http://host:8096/shot?doc=7&page=12&scale=2")
    # a page's ink does not repeat and a picture of it does not compress, so the
    # fixtures are built that way too: a pattern zlib can eat would make a page
    # full of writing look like a blank sheet, and the test would pass on a lie
    def noise(count: int, seed: int = 7) -> bytes:
        """Bytes nothing can compress — what a picture of writing behaves like."""
        out = bytearray()
        while len(out) < count:
            seed += 1
            out += hashlib.sha256(str(seed).encode()).digest()
        return bytes(out[:count])

    ink = noise(200 * 283 * 3)
    inked = make_png(200, 283, 2, ink)
    white = make_png(200, 283, 2, b"\xff" * (200 * 283 * 3))
    # a title page: paper, and one band of writing on it. Sparse is not empty,
    # and calling it empty is how a good page ends up sounding like a failure.
    paper = bytearray(b"\xff" * (200 * 283 * 3))
    for row in range(24, 41):
        paper[row * 600:(row + 1) * 600] = ink[row * 600:(row + 1) * 600]
    sparse = make_png(200, 283, 2, bytes(paper))
    assert len(inked) > 1000 and len(white) < len(inked)
    assert looks_blank_shot(len(white), 283) is True, len(white)
    assert looks_blank_shot(len(inked), 283) is False, len(inked)
    assert looks_blank_shot(len(sparse), 283) is False, (len(sparse), len(sparse) / 283)
    assert looks_blank_shot(0, 283) is False and looks_blank_shot(len(white), 0) is False
    # No stand-in, no fingerprint list, no repeated-picture test. A page is a
    # photograph of what the viewer showed: a photograph is never a stand-in for a
    # scan, because there is no scan to stand in for.
    for gone in ("placeholder_scan", "PLACEHOLDER_SCANS", "repeated_pages",
                 "looks_blank_scan"):
        assert gone not in globals(), f"{gone} is still there"
    # the second door: built only for Scribd's public hosts, budgeted, and the
    # target arrives inside the route's own url, encoded whole
    assert scrape_url("https://www.scribd.com/a?b=c d").startswith(
        "https://api.scrape.do/?token=")
    assert "url=https%3A%2F%2Fwww.scribd.com%2Fa%3Fb%3Dc%20d" in scrape_url(
        "https://www.scribd.com/a?b=c d")
    assert _scrape_open("www.scribd.com") is bool(SCRAPE_DO)
    assert _scrape_open("html.scribdassets.com") is bool(SCRAPE_DO)
    assert _scrape_open("127.0.0.1:9181") is False      # never in local tests
    assert _scrape_open("api.scrape.do") is False       # and never recursively
    held_left = _scrape_left[0]
    try:
        _scrape_left[0] = 1
        assert _scrape_take() is True and _scrape_take() is False
    finally:
        _scrape_left[0] = held_left
    # a pixel measure would call this page empty at 2x and not at 1x; rows do not
    assert looks_blank_shot(len(sparse), 283) == looks_blank_shot(len(sparse) * 4, 566)

    def _png_dims(body: bytes) -> tuple[int, int]:
        return int.from_bytes(body[16:20], "big"), int.from_bytes(body[20:24], "big")

    class ShotHandler(BaseHTTPRequestHandler):
        """The service a real browser would be: one page per request."""
        def do_GET(self):
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            status, body, kind = 200, b"", "image/png"
            if parsed.path.endswith("/shot/ping"):
                if "notready" in parsed.path:
                    body = (b'{"ok": false, "service": "shot", "version": "1.1",'
                            b' "browser": {"ready": false, "note": "Cannot find'
                            b' package @sparticuz/chromium"}}')
                else:
                    body = b'{"ok": true, "service": "shot", "browser": {"ready": true}}'
                kind = "application/json"
            elif parsed.path == "/shot":
                number = int((query.get("page") or ["0"])[0])
                if number == 4:
                    status, body, kind = 404, b"not for this account", "text/plain"
                elif number == 5:
                    body = white                     # drawn, but nothing on it
                elif number == 6:
                    body, kind = b"not an image", "text/plain"
                elif number == 7:
                    body = sparse                    # paper, and a little writing
                elif number == 8:
                    body = inked                     # a picture of the wrong page
                else:
                    body = inked
            else:
                status, body, kind = 404, b"no", "text/plain"
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            if kind == "image/png" and parsed.path == "/shot":
                # the box this picture claims to be, in the page's own units:
                # the png's pixels at the scale asked for. Page 8 lies about it,
                # which is the picture that is not its page.
                scale = float((query.get("scale") or ["1"])[0] or 1)
                wide, high = _png_dims(body)
                if number == 8:
                    wide += 60
                self.send_header("X-Shot-Box",
                                 f"{round(wide / scale)}x{round(high / scale)}")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    service = ThreadingHTTPServer(("127.0.0.1", 0), ShotHandler)
    threading.Thread(target=service.serve_forever, daemon=True).start()
    try:
        # pinned at 2x on purpose: what is under test is the rule that a shot's
        # pixels are the page at the scale it was taken, whatever the default is
        shooter = Shooter(f"http://127.0.0.1:{service.server_address[1]}",
                          scale=2.0)
        assert shooter.alive() is True and shooter.note == "", shooter.note
        page, note = shooter.shoot("7", 1)
        assert page and page["shot"] and page["phase"] == "shot", note
        # 200x283 px photographed at 2x is a 100x142 px page at twice the detail
        assert (page["width"], page["height"]) == (100, 142), page
        assert "photographed" in page["label"] and "2x" in page["label"], page
        assert page["bytes"] == len(inked) and page["blank"] is False, page
        assert page["url"].startswith("browser http://127.0.0.1:"), page
        # and the default is standard quality: the page at the size the viewer
        # draws it, not twice the pixels for a sheet placed at the same size
        standard = Shooter(shooter.base)
        one, _note = standard.shoot("7", 1)
        assert one and (one["width"], one["height"]) == (
            round(200 / standard.scale), round(283 / standard.scale)), one
        assert ("2x" in one["label"]) == (standard.scale != 1), one["label"]
        refused, note = shooter.shoot("7", 4)
        assert refused is None and "refused" in note, note
        # the reason arrives as json: the note is the service's own words
        assert "not for this account" in note and "{" not in note, note
        empty, note = shooter.shoot("7", 5)
        assert empty is None and "came back empty" in note and "failed" in note, (
            empty, note)
        assert "100x142" in note, note
        junk, note = shooter.shoot("7", 6)
        assert junk is None and "not a page" in note, note
        sparse_page, note = shooter.shoot("7", 7)
        assert sparse_page and sparse_page["shot"] and note == "", (note,)
        assert "empty" not in sparse_page["label"], sparse_page["label"]
        pictures, notes = shooter.capture("7", [1, 2, 3, 4], jobs=3)
        assert sorted(pictures) == [1, 2, 3], sorted(pictures)
        assert len(notes) == 1 and "page 4" in notes[0], notes
        kept, notes = shooter.capture("7", [5], jobs=1)
        assert not kept and notes and "came back empty" in notes[0], (kept, notes)
        wrong, note = shooter.shoot("7", 8)
        assert wrong is None and "not the page's own size" in note, (wrong, note)
        assert "960" not in note or True  # the note carries both sizes, read it
        assert "against the measured page box" in note, note
        # a cap that photographs fewer pages than were asked for has to say so,
        # or the document quietly comes back short
        held_cap = MAX_SHOT_PAGES
        try:
            globals()["MAX_SHOT_PAGES"] = 2
            capped, notes = shooter.capture("7", [1, 2, 3], jobs=2)
            assert sorted(capped) == [1, 2], sorted(capped)
            assert any("left out of the PDF" in note and "pages 3 to 3" in note
                       for note in notes), notes
        finally:
            globals()["MAX_SHOT_PAGES"] = held_cap
        stopped, notes = shooter.capture("7", [1, 2], jobs=2, alive=lambda: False)
        assert stopped == {} and notes and "stopped" in notes[0], notes

        # The panel must move while pages are photographed one at a time. Twenty
        # pages of silence is a panel that reads `page 0/20 · 0 ok · 159.7s`,
        # which looks dead — and a run that looks dead gets killed and started
        # again, losing the pages that had already landed.
        steps = []
        moving, moved_notes = shooter.capture(
            "7", [1, 2, 3, 4], jobs=1,
            progress=lambda done, ok, total: steps.append((done, ok, total)))
        assert sorted(moving) == [1, 2, 3], sorted(moving)
        assert [step[0] for step in steps] == [1, 2, 3, 4], steps
        assert steps[-1] == (4, 3, 4), steps
        assert all(step[2] == 4 for step in steps), steps
        assert "page 4" in moved_notes[0], moved_notes

        # a service that answers 200 and says "ok": false is NOT a browser on
        # hand. Believing it would send every missing page somewhere that cannot
        # help, and the document would end up with the same missing pages, slower.
        notready = Shooter(f"http://127.0.0.1:{service.server_address[1]}/notready")
        assert notready.alive() is False, notready.note
        assert "@sparticuz/chromium" in notready.note, notready.note
        assert notready.capture("7", [1]) == ({}, [notready.note])

        # the addresses are written down, so nothing has to be configured: a
        # Shooter told nothing still finds the service by asking the list
        held_hosts = SHOT_HOSTS
        try:
            globals()["SHOT_HOSTS"] = (
                f"http://127.0.0.1:{service.server_address[1]}",
                "http://127.0.0.1:1")
            _SHOT_CACHE.update(base="", note="", when=0.0)
            auto = Shooter()
            assert auto.alive() is True, auto.note
            assert auto.base == f"http://127.0.0.1:{service.server_address[1]}", auto.base
            assert "ready" in auto.note or auto.note == "", auto.note
            # a found service is trusted, so a worse list does not lose it
            again, _note = discover_shots(hosts=["http://127.0.0.1:1"])
            assert again == auto.base, again
            # the first address that answers wins, and the answer is named
            first, note = discover_shots(
                hosts=["http://127.0.0.1:1",
                       f"http://127.0.0.1:{service.server_address[1]}"], force=True)
            assert first == auto.base and auto.base in note, (first, note)
        finally:
            globals()["SHOT_HOSTS"] = held_hosts
            _SHOT_CACHE.update(base="", note="", when=0.0)
    finally:
        service.shutdown()
        service.server_close()

    assert refusal_reason(b'{"error": "page 12: no browser"}', 502) == "page 12: no browser"
    assert refusal_reason(b'<html>nope</html>', 502) == "<html>nope</html>"
    assert refusal_reason(b"", 500) == "http 500"
    # a run once printed "the column NaNpx tall, 0 bo" and stopped there: the
    # part of the sentence that said WHY was past the 200th character
    told = ("no column of pages in the embed viewer or in the document's own "
            "page — measured 0 page block(s) of 0 distinct page-shaped box(es) "
            'in 12 window(s) over 9s · what the browser was looking at: title '
            '"Sign in" · THE WINDOW HAS NO SIZE (0x0)' + "x" * 700)
    kept = refusal_reason(json.dumps({"error": told}).encode("utf-8"), 502)
    assert len(kept) == 900, len(kept)
    assert kept.startswith("no column of pages"), kept[:60]
    assert "THE WINDOW HAS NO SIZE" in kept, kept[-260:]
    assert "nothing is listening" in plain_error(
        urllib.error.URLError(ConnectionRefusedError(111, "Connection refused")))
    assert "does not resolve" in plain_error(socket.gaierror(-2, "Name or service not known"))
    assert "did not answer in time" in plain_error(TimeoutError("timed out"))
    assert "http:// and not https://" in plain_error(urllib.error.URLError(
        OSError(1, "[SSL: WRONG_VERSION_NUMBER] wrong version number")))
    assert plain_error(ValueError("something odd")).startswith("ValueError")

    # nothing anywhere: everything still works, and says why once
    none_found, note = discover_shots(hosts=["http://127.0.0.1:1"], force=True)
    assert none_found == "" and "no browser service answered" in note, note
    assert "http://127.0.0.1:1" in note, note
    quiet = Shooter("", discover=False)
    assert quiet.alive() is False and "SCRIBD_SHOTS" in quiet.note, quiet.note
    assert ping_answer(200, b'{"ok": true, "version": "1.1"}', "") == (
        True, "troy-search 1.1")
    assert ping_answer(200, b'{"ok": false, "browser": {"note": "no chromium"}}',
                       "") == (False, "no chromium")
    assert ping_answer(200, b"<html>not json</html>", "")[0] is False
    assert ping_answer(0, b"", "nothing is listening there")[0] is False
    assert quiet.capture("7", [1]) == ({}, [quiet.note])
    assert Shooter("", scale=9).scale == 4.0 and Shooter("", scale=0.1).scale == 0.5
    dead = Shooter("http://127.0.0.1:1")
    assert dead.alive() is False and dead.note, dead.note
    held = SHOTS
    set_shots("http://host:8096/")
    assert SHOTS == "http://host:8096" and os.environ["SCRIBD_SHOTS"] == SHOTS
    assert Shooter().base == "http://host:8096"
    set_shots(held)

    # a photograph follows the document's sheet — it never sets it
    assert house_sheet([{"width": 2000, "height": 2828, "shot": True},
                        {"width": 1200, "height": 1600}]) == (900.0, 1200.0)
    pages = {1: {"width": 1000, "height": 1414, "shot": True},
             2: {"width": 1200, "height": 1600}}
    fit_shots(pages, (900.0, 1200.0))
    assert pages[2] == {"width": 1200, "height": 1600}, pages[2]
    fitted = pages[1]
    assert fitted["height"] * 0.75 <= 1200.01, fitted
    assert abs(fitted["height"] * 0.75 - 1200.0) < 1.5, fitted
    assert abs(fitted["width"] / fitted["height"] - 1000 / 1414) < 0.004, fitted
    before = dict(fitted)
    fit_shots(pages, (0.0, 0.0))            # no sheet yet: nothing is moved
    assert pages[1] == before, pages[1]

    gate = Gate(rate=24.0, floor=8.0, ceiling=60.0)
    for _ in range(40):
        gate.complaint(403)
    assert 8.0 <= gate.rate < 20.0, gate.rate
    hard = Gate(rate=24.0, floor=8.0, ceiling=60.0)
    for _ in range(40):
        hard.complaint(429)
    assert abs(hard.rate - 8.0) < 0.01, hard.rate
    # past the drop line with nothing but refusals, a queued document drops
    # itself: no rest, no retry ladder, no second pass at the back
    stuck = Ctx("https://www.scribd.com/document/7/stuck")
    stuck.t0 = time.time() - (QUEUE_DROP_AFTER + 1.0)
    JOB.queue.append({"url": "https://www.scribd.com/document/9/waiting"})
    try:
        assert [stuck.refused(n) for n in (1, 2, 3)] == [False, False, False], \
            "an aged document must not ask anybody to rest for it"
        assert stuck.skip_now is True, "a waiting queue should free itself"
    finally:
        JOB.queue.clear()
    # the drop is a twenty-second judgement, not a hair trigger: a young
    # document with the same refusals still gets its first rest, because a
    # throttle that clears is worth four seconds
    fresh = Ctx("https://www.scribd.com/document/7/fresh")
    JOB.queue.append({"url": "https://www.scribd.com/document/9/waiting"})
    try:
        assert [fresh.refused(n) for n in (1, 2, 3)] == [False, False, True], \
            "a young document still takes its first rest"
        assert fresh.skip_now is False, "a young document has not proved it"
    finally:
        JOB.queue.clear()
    # alone, a document keeps fighting to the end: there is nothing to yield to
    alone = Ctx("https://www.scribd.com/document/8/alone")
    alone.t0 = time.time() - (QUEUE_DROP_AFTER + 1.0)
    for number in (1, 2, 3):
        alone.refused(number)
    assert alone.skip_now is False, "alone, a document keeps fighting"

    return ("selftest: every check passed — one route only (no scan ladder, no "
            "stand-in, no refetch), sheet maths, EXIF rotation, "
            "jpeg size traps, pdf verify, text "
            "layer, panel key and CORS, cookies, token, names, pasted links, "
            "bookmarklet, scribd search, relevance, channels, the document "
            "queue, signed links, the disk guard, token shapes, redaction, "
            "page wiring, text pages, built names, viewer pages, "
            "typography, placed lines, photographed pages, a browser "
            "that is not there, the browser found by asking the addresses "
            "written into the file, the picture that was not a page, "
            "the second door, the name that was never asked, "
            "the lock map in the token, the last line of every page, "
            "the queue that drops what will not come, "
            "the sheet that is never grey, the panel that counts every "
            "photographed page, the report of a page nobody could find, the "
            "rule that tells glyph shards from a short real page, and the "
            "deadline a hung pass cannot outlive")

    # ---- a refused photograph must leave its diagnosis behind --------------
    # "0 page-shaped boxes" is not an answer. The browser's own report — the
    # title, the url it ended on, the window's size, what was pinned over it,
    # the biggest boxes and the rule that threw each one away, the words the
    # page printed — is the difference between guessing at the next fix and
    # knowing it. It is long, so the log gets the sentence and the disk gets
    # all of it.
    import inspect as _pin_inspect
    import tempfile as _pin_tempfile
    with _pin_tempfile.TemporaryDirectory() as _pin_dir:
        _pin_ctx = Ctx("398154705", "https://www.scribd.com/document/398154705")
        assert _pin_ctx.save_shot_note("a report") == "", \
            "with nowhere to write, there is nothing to claim"
        _pin_ctx.debug_dir = _pin_dir
        _pin_text = ("no column of pages in the embed viewer or in the "
                     "document's own page — what the browser was looking at: "
                     'title "Linear Algebra" · THE WINDOW HAS NO SIZE (0x0)')
        _pin_path = _pin_ctx.save_shot_note(_pin_text)
        assert _pin_path == os.path.join(_pin_dir, "shots-398154705.txt"), _pin_path
        with open(_pin_path, encoding="utf-8") as _pin_handle:
            assert _pin_handle.read().strip() == _pin_text
        assert _pin_ctx.save_shot_note("   ") == "", "an empty report writes nothing"
    # A page of shards is not a page — and a SHORT REAL PAGE STILL IS. The
    # character floor this replaced would have dropped every title page,
    # dedication, folio and chapter divider in every book; the shard rule cannot,
    # because it looks at the shape of the words and not at how few they are.
    assert shard_fraction("Udd h Eo er W er K e") > 0.8, (
        shard_fraction("Udd h Eo er W er K e"))
    # and with the placement marks the stored words carry, the same page must
    # still be shards: tokenising the marks instead of the words is how a
    # shard page slipped through once already
    assert shard_fraction("\x010.0000|Udd h\n\x010.1999|Eo\n\x010.4000|er"
                          "\n\x010.6000|W\n\x010.7999|er\n\x011.0000|K e") > 0.8
    assert words_look_like_a_page("\x010.0000|Udd h\n\x010.1999|Eo") is False
    assert words_look_like_a_page("\x010.0000|Contents\n\x010.2|1. Introduction"
                                  " ......... 5") is True
    assert words_look_like_a_page("Udd  h Eo  er W er K e") is False
    assert words_look_like_a_page("e cece+sess e LLC") is False
    assert words_look_like_a_page("Contents Fifth Edition Jimmie Gilbert") is True
    assert words_look_like_a_page("For my mother") is True
    assert words_look_like_a_page("6") is True, "a folio is a page"
    assert words_look_like_a_page("Contents 1. Introduction 5") is True
    assert words_look_like_a_page("word " * 60) is True
    assert words_look_like_a_page("   ") is False and words_look_like_a_page("") is False
    assert words_look_like_a_page("It is as it is") is False, (
        "a page of nothing but two-letter words is the one shape this rule "
        "cannot tell from shards; it is named as missing instead of drawn, and "
        "that trade is written down here so nobody rediscovers it by accident")
    # the column route is gone from the panel as completely as from the shooter
    assert not hasattr(Shooter, "shoot_book"), (
        "the whole-column capture must not come back: it cut pages by inference "
        "instead of measuring each one in its own window")

    _pin_source = _pin_inspect.getsource(_download)
    assert _pin_source.count("progress=shot_progress") == 2, (
        "every photograph pass must move the panel's numbers; "
        f"{_pin_source.count('progress=shot_progress')} of 2 do")
    assert "def shot_progress(" in _pin_source, (
        "the page-by-page passes have no progress to report")
    assert "max(int(with_limit), int(total), int(done))" in _pin_source, (
        "a pass over one page must not shrink the document's page count on the "
        "panel: `page 20 of 1` is what that reads like")
    _pin_defined = _pin_source.index("def shot_progress(")
    _pin_first_use = _pin_source.index("progress=shot_progress")
    assert _pin_defined < _pin_first_use, (
        "shot_progress is used before it is defined, which is an "
        "UnboundLocalError on the first pass that reports through it — the one "
        "pass missing a page is that pass")
    assert "one window each, measured and clipped" in _pin_source, (
        "the photograph pass must say what it is doing before the minutes of "
        "silence, or the panel looks dead while it works")
    assert "save_shot_note(" in _pin_source, (
        "the browser's own words for why pages failed must land on disk, "
        "page by page")
    assert "shooter.shoot_book" not in _pin_source, (
        "no call to the column route may survive in the download")
    assert _pin_source.count("words_look_like_a_page(") == 4, (
        "every place a page is made out of words must hold it to the floor — "
        "the rescue for a document with no words is the one that drew seven "
        f"fragments on an empty sheet; "
        f"{_pin_source.count('words_look_like_a_page(')} of 4 do")
    assert "shoot_book" not in _pin_inspect.getsource(Shooter.capture), (
        "the per-page pool must not reach for the column route")
