
def main(argv: list[str]) -> int:
    global BASE
    urls: list[str] = []
    links_text = ""
    limit = 0
    out = OUT
    cookies = ""
    jobs = 12
    name = ""
    check = True
    placeholder = True
    verify = True
    text = False
    probe = 0
    find_text = ""
    find_asked = False
    find_pages = 1
    pick = ""
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in ("--url", "--links", "--limit", "--out", "--cookies", "--base",
                   "--jobs", "--name", "--probe", "--find", "--pages",
                   "--pick", "--shots") and index + 1 < len(argv):
            value = argv[index + 1]
            if arg == "--find":
                find_text = value.strip()
                find_asked = True
            elif arg == "--pages":
                find_pages = as_page(value)
            elif arg == "--pick":
                pick = value.strip()
            elif arg == "--url":
                urls.append(value.strip())
            elif arg == "--links":
                links_text += "\n" + value
            elif arg == "--limit":
                limit = as_limit(value)
            elif arg == "--out":
                out = value
            elif arg == "--cookies":
                cookies = value
            elif arg == "--name":
                name = value
            elif arg == "--probe":
                probe = as_limit(value, 0, FIND_MAX_PAGE)
            elif arg == "--jobs":
                jobs = as_page(value, 12)
                jobs = max(1, min(jobs, 32))
            elif arg == "--shots":
                set_shots(value)
            else:
                BASE = value.rstrip("/")
            index += 2
            continue
        if arg == "--no-check":
            check = False
        elif arg == "--no-placeholder":
            placeholder = False
        elif arg == "--no-verify":
            verify = False
        elif arg in ("--text", "--text-layer"):
            text = True
        elif arg == "--shots-only":
            pass                      # there is only one route now: photographs
        elif arg == "--scans":
            # Removed, not switched off. Say so once and carry on with the route
            # there is, rather than aborting a job somebody started.
            print("--scans is gone: every page of every document is "
                  "photographed, and nothing brings scanning back.")
        elif arg == "--selftest":
            print(selftest())
            return 0
        elif arg in ("-h", "--help"):
            print(__doc__)
            return 0
        elif arg == "--verify" and index + 1 < len(argv):
            sound, report = verify_pdf(argv[index + 1])
            print(("OK     " if sound else "BROKEN ") + report)
            return 0 if sound else 1
        elif arg.startswith("--base="):
            BASE = arg.split("=", 1)[1].rstrip("/")
        elif arg.startswith("--shots="):
            set_shots(arg.split("=", 1)[1])
        index += 1
    if cookies:
        os.environ["COOKIES"] = cookies
    if find_asked and not find_text:
        print('--find needs a few words: --find "physics 12th"')
        return 2
    if pick and not find_text:
        print('--pick only makes sense with --find "your words"')
        return 2
    if find_text:
        hits, notes = find_documents(find_text, find_pages)
        for note in notes:
            print(f"  {note}")
        if not hits:
            print("no documents found — nothing to download")
            return 1
        print_hits(hits)
        if not pick:
            print(f"{len(hits)} document(s) — add --pick 1,3 to download any of them")
            return 0
        chosen = picked_hits(hits, pick)
        if not chosen:
            print(f"nothing matches --pick {pick} (there are {len(hits)})")
            return 2
        print(f"downloading {len(chosen)} of {len(hits)} document(s)")
        urls += [hit["url"] for hit in chosen]
    if links_text.strip():
        urls += links_from_text(links_text)
    urls = [item for item in dict.fromkeys(urls) if item]
    if urls:
        run_job(urls, limit, out, jobs, name=name, check=check,
                placeholder=placeholder, probe_page=probe, verify=verify,
                text=text)
        return 0 if JOB.verdict in ("PDF BUILT", "PDF PARTIAL", "PROBE DONE") else 1
    # 25811 is the port this panel is reached on; an egg that sets SERVER_PORT
    # still wins, and a bare `python scribd_download.py` now binds the right one
    port = int(os.environ.get("SERVER_PORT") or os.environ.get("PORT")
               or PANEL_PORT)
    serve(port, out)
    return 0
