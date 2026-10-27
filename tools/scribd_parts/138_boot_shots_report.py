

def boot_shots_report() -> None:
    """Ask for the browser at boot, off the serving thread, and say the answer.

    The browser is another host now, so the panel opens its own door first and
    asks afterwards: whether a page nobody sends can be photographed is still
    said before anybody presses download, but a host that does not answer cannot
    hold the panel shut while it times out.
    """
    def say(text: str) -> None:
        print(text, flush=True)

    try:
        found, note = discover_shots(timeout=6.0)
        if not found:
            found = scan_for_shooter(announce=say)
            if found:
                # asked once more, so the note is the browser's own words and the
                # answer is warm in the cache before the first document asks
                again, why = discover_shots(hosts=[found], force=True,
                                            timeout=6.0)
                note = why if again else found
        say(("photographing pages: " + note) if found else
            ("photographing pages: none — " + note))
    except Exception as trouble:                          # noqa: BLE001
        say(f"photographing pages: unknown — asking failed ({plain_error(trouble)})")
