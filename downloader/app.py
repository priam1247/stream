"""Command line entrypoint for the screenshot-only Scribd downloader panel.

The panel is a small, self-contained HTTP service. It runs in two ways:

* package mode, from the repository root::

      python -m downloader              # via downloader/__main__.py
      python -m downloader.app

* standalone mode, when the ``downloader/`` folder is deployed on its own::

      python app.py                     # from inside downloader/
      sh start.sh                       # deployment wrapper (Procfile)

Flags::

    --selftest     run offline checks (no browser, no Scribd network) and exit
    --health       print the panel health JSON and exit
    --host HOST    bind address (default 0.0.0.0)
    --port PORT    bind port (default 25811, or $SCRIBD_PANEL_PORT/$PORT)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent

if __package__ in (None, ""):
    # Standalone (`python downloader/app.py` or `python app.py`): import the
    # sibling modules as top-level so the folder works as an independent app.
    if str(_HERE) not in sys.path:
        sys.path.insert(0, str(_HERE))
    import capture  # type: ignore[no-redef]
    import config  # type: ignore[no-redef]
    import panel  # type: ignore[no-redef]
    import scribd  # type: ignore[no-redef]
else:
    from . import capture, config, panel, scribd  # type: ignore[no-redef]


def _selftest() -> int:
    """Offline checks: config, search/metadata, capture helpers, PDF, HTTP.

    Deliberately needs no Playwright browser and makes no Scribd network call.
    It just needs the pinned packages from requirements.txt (Pillow, img2pdf,
    pypdf). It leaves no files behind outside a TemporaryDirectory.
    """
    import tempfile
    import urllib.error
    import urllib.request

    from PIL import Image, ImageDraw
    from pypdf import PdfReader

    checks = 0

    def ok(label: str, condition: bool, extra: str = "") -> None:
        nonlocal checks
        assert condition, f"{label} FAILED {extra}"
        checks += 1
        print(f"  ok  {label}")

    print(f"Scribd screenshot panel v{config.VERSION} — offline selftest")

    # ---- config -----------------------------------------------------------
    ok(
        "safe_filename",
        config.safe_filename("Physics 12th", "123456") == "Physics 12th-123456.pdf",
        config.safe_filename("Physics 12th", "123456"),
    )
    ok("safe_name blocks traversal", config.safe_name("../../etc/passwd") == "")
    ok("port default", isinstance(config.port(), int) and config.port() > 0)

    # ---- scribd helpers ---------------------------------------------------
    url = (
        "https://www.scribd.com/document/123456789/Physics-Twelfth"
        "?access_key=key-abc"
    )
    ok("clean_url keeps access_key", "access_key=key-abc" in scribd.clean_url(url), scribd.clean_url(url))
    ok("doc_id_of", scribd.doc_id_of(url) == "123456789", scribd.doc_id_of(url))
    embed = scribd.embed_url(url)
    ok(
        "embed_url carries access_key + scroll",
        "access_key=key-abc" in embed and "view_mode=scroll" in embed,
        embed,
    )
    ok("page_count_from_html", scribd.page_count_from_html('{"page_count": 12}') == 12)
    ranked = scribd.rank_hits(
        [
            {"id": "2", "title": "Random notes", "url": "https://www.scribd.com/document/2/r", "pages": 3},
            {"id": "1", "title": "Physics Twelfth", "url": "https://www.scribd.com/document/1/p", "pages": 12},
        ],
        "physics twelfth",
    )
    ok("rank_hits puts exact match first", ranked[0]["id"] == "1")

    # ---- /find -> /run page-count handoff (dashboard posts bare URLs) -----
    canned = {
        "total_results_count": 1,
        "page_count": 1,
        "results": [
            {
                "id": "123456789",
                "title": "Physics &amp; Twelfth",
                "pageCount": 12,
                "reader_url": "https://www.scribd.com/document/123456789/Physics-Twelfth",
                "authors": [{"name": "A. Writer"}],
                "views": 5000,
            }
        ],
    }
    original_fetch = scribd.fetch
    scribd.CACHE.clear()

    def fake_fetch(_url, *, referer="", json_answer=False):  # noqa: ANN001
        return scribd.FetchResult(200, json.dumps(canned).encode("utf-8"), "")

    scribd.fetch = fake_fetch  # type: ignore[assignment]
    try:
        found = scribd.find_page("physics twelfth", 1)
        ok("find_page returns a hit", len(found["hits"]) == 1, str(found)[:200])
        hit = found["hits"][0]
        ok("find_page hit has 12 pages", hit.get("pages") == 12, str(hit))
        ok(
            "find_page keeps dashboard hit shape",
            {"id", "title", "url", "pages", "views", "author", "match"}.issubset(hit),
            str(sorted(hit)),
        )
        ok("find_page unescapes title", "Physics & Twelfth" in hit.get("title", ""), str(hit.get("title")))
    finally:
        scribd.fetch = original_fetch  # type: ignore[assignment]

    # CACHE.remember happened inside find_page. /run now gets only the URL.
    queued = scribd.normalise_documents(
        {"urls": [hit["url"]], "links": "", "limit": 0, "text": False, "jobs": 16}
    )
    ok("/run resolves cached page count", len(queued) == 1 and queued[0].pages == 12, str(queued))
    ok("/run resolves cached title", len(queued) == 1 and queued[0].title, str(queued))
    ok("/run resolves cached author", len(queued) == 1 and queued[0].author == "A. Writer", str(queued))
    scribd.CACHE.clear()

    # ---- capture pure helpers --------------------------------------------
    boxes = [
        {"number": 1, "left": 10, "right": 610, "top": 0, "bottom": 800},
        {"number": 2, "left": 10, "right": 610, "top": 820, "bottom": 1620},
        {"number": 3, "left": 10, "right": 610, "top": 1640, "bottom": 2440},
    ]
    clips = capture.clips_from_boxes(boxes, 620, 2440)
    ok("clips_from_boxes count", len(clips) == 3, str(len(clips)))
    ok(
        "clips do not overlap / cut next page",
        all(clips[i]["y"] + clips[i]["height"] <= clips[i + 1]["y"] for i in range(len(clips) - 1)),
        str(clips),
    )

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        images: list[Path] = []
        for number in range(1, 13):
            image = Image.new("RGB", (480, 600), (255, 255, 255))
            draw = ImageDraw.Draw(image)
            draw.rectangle([20, 20 + number * 3, 460, 200 + number * 3], fill=(30, 120, 110))
            path = work / f"page-{number:04d}.jpg"
            image.save(path, "JPEG", quality=85)
            images.append(path)
        output = work / "out.pdf"
        capture.build_pdf(images, output, 12)
        reader = PdfReader(str(output))
        ok("build_pdf made 12 pages", len(reader.pages) == 12, str(len(reader.pages)))
        ok(
            "build_pdf page box non-empty",
            float(reader.pages[0].mediabox.width) > 0 and float(reader.pages[0].mediabox.height) > 0,
        )
        white = work / "white.jpg"
        Image.new("RGB", (480, 600), (255, 255, 255)).save(white, "JPEG")
        ok("is_blank rejects a white page", capture.is_blank(white))
        ok("is_blank keeps a real page", not capture.is_blank(images[0]))

    # ---- HTTP surface (real socket, no browser, no network) --------------
    server = panel.make_server("127.0.0.1", 0)
    import threading

    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
    )
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def get(path: str):
        with urllib.request.urlopen(base + path, timeout=5) as answer:
            return answer.status, json.loads(answer.read().decode("utf-8"))

    def post(path: str, body: dict):
        data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            base + path, data=data, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=5) as answer:
            return answer.status, json.loads(answer.read().decode("utf-8"))

    try:
        status_code, health = get("/health")
        ok("GET /health", status_code == 200 and health.get("ok") is True, str(health))
        status_code, state = get("/status")
        ok(
            "GET /status shape",
            status_code == 200 and "progress" in state and "queue" in state,
            str(state)[:160],
        )
        status_code, cfg = get("/config")
        ok("GET /config", status_code == 200 and cfg.get("capture") == "screenshot-boundaries", str(cfg))
        status_code, files = get("/files")
        ok("GET /files", status_code == 200 and "files" in files, str(files))
        status_code, link = get("/link")
        ok("GET /link", status_code == 200 and "url" in link, str(link))
        status_code, diag = get("/diag")
        ok("GET /diag", status_code == 200 and diag.get("ok") is True, str(diag))
        status_code, empty = post("/find", {"query": ""})
        ok("POST /find empty query", status_code == 200 and empty.get("hits") == [], str(empty)[:160])
        try:
            post("/run", {"urls": []})
            ok("POST /run empty -> 400", False, "did not reject")
        except urllib.error.HTTPError as exc:
            ok("POST /run empty -> 400", exc.code == 400, str(exc.code))
        status_code, reset = post("/reset", {})
        ok("POST /reset", status_code == 200 and reset.get("ok") is True, str(reset))
        with urllib.request.urlopen(base + "/", timeout=5) as answer:
            ui = answer.read().decode("utf-8")
        ok("GET / serves search-first UI", "Download ticked" in ui)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    print(f"SELFTEST OK — {checks} checks passed")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Screenshot-only Scribd downloader panel (Playwright Chromium)."
    )
    parser.add_argument("--selftest", action="store_true", help="run offline checks and exit")
    parser.add_argument("--health", action="store_true", help="print health JSON and exit")
    parser.add_argument("--host", default=config.HOST, help="bind host (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=None, help="bind port (default 25811)")
    args = parser.parse_args(argv)

    if args.selftest:
        return _selftest()
    if args.health:
        print(json.dumps(panel.PANEL.health()))
        return 0
    panel.serve(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
