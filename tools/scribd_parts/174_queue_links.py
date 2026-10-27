

# ---------------------------------------------------------------------------
# page
# ---------------------------------------------------------------------------
def queue_links(urls: list[str], limit: int, out: str) -> tuple[bool, str]:
    """Start a download of these links, unless a job is already running."""
    with JOB.lock:
        busy = JOB.state == "running"
    if busy:
        return False, "a download is already running — try again when it finishes"
    if not urls:
        return False, "no Scribd document links in that request"
    threading.Thread(target=run_job, args=(list(urls), limit, out),
                     daemon=True).start()
    return True, f"queued {len(urls)} link(s)"
