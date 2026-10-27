
def serve(port: int, out: str) -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            pass

        def _send(self, body: bytes, ctype: str, code: int = 200,
                  extra: dict | None = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for name, value in cors_headers(self.headers.get("Origin", "")).items():
                self.send_header(name, value)
            for name, value in (extra or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def _allowed(self, path: str) -> bool:
            """One gate in front of every route, so none can be forgotten."""
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if panel_gate(self.headers, query, self.headers.get("Cookie", "")):
                return True
            if path == "/health":
                return True                      # uptime checks stay open
            if path == "/file" or path.startswith("/file/") or path == "/logs":
                # a signed link (minted by the dashboard) opens one file, briefly
                wanted = (os.path.basename(path) if path.startswith("/file/")
                          else (query.get("name") or [""])[0])
                if wanted and token_ok(urllib.parse.unquote(wanted),
                                       (query.get("e") or [None])[0],
                                       (query.get("t") or [""])[0]):
                    return True
            what = ("application/json" if path not in ("/", "/send", "/logs")
                    else "text/html")
            if what == "application/json":
                self._send(json.dumps({"error": "this panel needs its key: send "
                                                "X-Panel-Key, or open ?key=…"}).encode(),
                           "application/json; charset=utf-8", 401)
            else:
                self._send(b"<h3>This panel is locked.</h3><p>Open it with "
                           b"?key=YOUR_KEY at the end of the address.</p>",
                           "text/html; charset=utf-8", 401)
            return False

        def do_OPTIONS(self) -> None:  # noqa: N802
            """Preflight for a dashboard that calls this panel from a browser."""
            self.send_response(204)
            for name, value in cors_headers(self.headers.get("Origin", "")).items():
                self.send_header(name, value)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
            if not self._allowed(path):
                return
            if path == "/status":
                self._send(json.dumps(JOB.snapshot()).encode(),
                           "application/json; charset=utf-8")
            elif path == "/health":
                # cheap enough for a dashboard to poll, and it says whether the
                # panel is locked so the other side can explain a 401 properly
                self._send(json.dumps({"ok": True, "version": VERSION,
                                       "locked": bool(PANEL_KEY),
                                       "state": JOB.state}).encode(),
                           "application/json; charset=utf-8")
            elif path == "/files":
                self._send(json.dumps({"files": panel_files(out)}).encode(),
                           "application/json; charset=utf-8")
            elif path in ("/file", "/file/") or path.startswith("/file/"):
                target = JOB.file
                if path.startswith("/file/"):
                    wanted = os.path.join(out, os.path.basename(path))
                    target = wanted if os.path.isfile(wanted) else ""
                if not target or not os.path.isfile(target):
                    self._send(b"no file yet", "text/plain", 404)
                    return
                with open(target, "rb") as handle:
                    body = handle.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Content-Disposition",
                                 f'attachment; filename="{os.path.basename(target)}"')
                self.end_headers()
                self.wfile.write(body)
            elif path == "/send":
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                urls = [item.strip() for item in query.get("url", []) if item.strip()]
                ok, message = queue_links(urls, 0, out)
                rows = "".join(f"<li>{html_escape(url)}</li>" for url in urls[:40])
                body = (SEND_PAGE
                        .replace("__HEADLINE__", html_escape(message))
                        .replace("__ROWS__", rows or "<li>nothing</li>")
                        .replace("__NOTE__", "the download is running — this "
                                 "page can be closed" if ok
                                 else "nothing started")).encode()
                self._send(body, "text/html; charset=utf-8", 200 if ok else 409)
            elif path == "/logs" or path.startswith("/logs/"):
                folder = os.path.join(out, "debug")
                if path == "/logs":
                    names = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
                    rows = "".join(f'<li><a href="/logs/{n}">{n}</a></li>' for n in names)
                    self._send(f"<h3>debug files</h3><ul>{rows}</ul>".encode(),
                               "text/html; charset=utf-8")
                    return
                name = os.path.basename(path)
                target = os.path.join(folder, name)
                if not os.path.isfile(target):
                    self._send(b"no such debug file", "text/plain", 404)
                    return
                with open(target, "rb") as handle:
                    body = handle.read()
                self._send(body, "text/plain; charset=utf-8")
            else:
                query = urllib.parse.parse_qs(
                    urllib.parse.urlparse(self.path).query)
                origin = (self.headers.get("X-Forwarded-Proto") and
                          self.headers.get("X-Forwarded-Host") and
                          f"{self.headers['X-Forwarded-Proto']}://"
                          f"{self.headers['X-Forwarded-Host']}") or \
                         (f"http://{self.headers.get('Host')}"
                          if self.headers.get("Host") else
                          f"http://localhost:{port}")
                code = bookmarklet(origin)
                embed = (query.get("embed") or [""])[0].lower() in ("1", "true", "yes")
                page = PAGE.replace("__EMBED_CSS__", EMBED_CSS if embed else "")
                extra = {"Set-Cookie": panel_cookie()} if PANEL_KEY else None
                self._send(page
                           .replace("__SAMPLE__", SAMPLE)
                           .replace("__BOOKMARKLET_TEXT__", html_escape(code))
                           .replace("__BOOKMARKLET_ATTR__", html_escape(code))
                           .encode(), "text/html; charset=utf-8", 200, extra)

        def do_POST(self) -> None:  # noqa: N802
            path = urllib.parse.urlparse(self.path).path
            if not self._allowed(path):
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception:  # noqa: BLE001
                payload = {}
            if path == "/find":
                query = str(payload.get("query") or "").strip()
                if not query:
                    self._send(json.dumps(
                        {"error": "type a few words to search for"}).encode(),
                        "application/json", 400)
                    return
                page = as_page(payload.get("page"))
                JOB.say(f"find: {query}" + (f" (page {page})" if page > 1 else ""))
                hits, note, info = find_page(query, page)
                JOB.say("find: " + note
                        + (f" · {info['total']} match(es)" if info.get("total") else ""))
                total = int(info.get("total") or 0)
                documents = int(info.get("documents") or 0)
                if hits and page == 1:
                    summary = f"{len(hits)} document(s) found"
                elif hits:
                    summary = f"+{len(hits)} more on page {page}"
                elif any(word in note for word in ("named no documents", "no more")):
                    summary = ("no documents match that" if page == 1
                               else "no more documents after this point")
                else:
                    summary = "the search did not answer"
                body = json.dumps({"hits": hits, "notes": [note],
                                   "summary": summary, "page": page,
                                   "total": total, "documents": documents,
                                   "max_page": FIND_MAX_PAGE,
                                   "per_page": FIND_PER_PAGE})
                self._send(body.encode(), "application/json; charset=utf-8")
                return
            if path == "/reset":
                # an admin escape hatch: stop a job that is not moving, so the
                # next download is not blocked by it
                stopped = JOB.stop(f"reset from the dashboard after "
                                   f"{int(JOB.quiet_for())}s without progress")
                JOB.say("reset: the running job was stopped" if stopped
                        else "reset: nothing was running")
                self._send(json.dumps({"ok": True, "stopped": stopped}).encode(),
                           "application/json")
                return
            if path != "/run":
                self._send(b'{"error":"unknown endpoint"}', "application/json", 404)
                return
            urls = payload.get("urls")
            if isinstance(urls, str):
                urls = [urls]
            if not isinstance(urls, list) or not urls:
                urls = [payload.get("url")] if payload.get("url") else []
            urls = [str(item).strip() for item in urls if str(item or "").strip()]
            if payload.get("links"):
                urls += links_from_text(str(payload.get("links")))
            urls = list(dict.fromkeys(urls))
            if not urls:
                self._send(b'{"error":"no Scribd document link in that text"}',
                           "application/json", 400)
                return
            limit = as_limit(payload.get("limit"))
            wants_text = bool(payload.get("text"))
            channels = as_channels(payload.get("jobs"))
            items = [{"url": url, "limit": limit, "text": wants_text,
                      "jobs": channels} for url in urls]
            started, gen, note = JOB.enqueue(items)
            if started:
                threading.Thread(target=run_queue, args=(gen, out, note),
                                 daemon=True).start()
            self._send(json.dumps({"ok": True, "queued": len(urls),
                                   "channels": channels,
                                   "started": started,
                                   "pending": JOB.pending()}).encode(),
                       "application/json")

    for line in prune_out(out):
        print(line, flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"open http://0.0.0.0:{port}/ — find documents, or paste a link",
          flush=True)
    print(f"cookies: {cookie_report(find_cookies())}", flush=True)
    # said at boot, not at the first document: whether a page nobody sends can be
    # photographed is the one thing worth knowing before you press download. Said
    # from its own thread, because the browser is a second server on a second
    # host, and asking it must not keep this panel's door shut while it answers.
    threading.Thread(target=boot_shots_report, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        server.server_close()
