
BASE = os.environ.get("SCRIBD_BASE", "").rstrip("/")   # only for local tests
# One load: a browser photographs what the viewer shows, for every document.
# Fetching Scribd's own page images was the other load, and it is gone — not
# switched off, removed. There is no SCRIBD_SCANS, no SCRIBD_SHOTS_ONLY and no
# --scans: a switch that turns a route off leaves the route in the file, and the
# next reader cannot tell whether it runs.
_POOL = threading.local()
