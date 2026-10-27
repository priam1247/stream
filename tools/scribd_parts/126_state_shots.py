
# ---------------------------------------------------------------------------
# the browser that photographs a page nobody sent us
# ---------------------------------------------------------------------------
# A page can come back with neither a scan nor the words behind it: the viewer
# builds that page's own token at runtime, and our requests never learn it. Text
# drawing cannot invent words, so such a page is photographed instead — by a
# browser, over one small HTTP request. That browser is a service (troy-search's
# /shot); this is the client, and it is deliberately optional: with no service
# configured, or one that will not answer, the document is built exactly as
# before. A photograph is a rescue, never a requirement.
SHOTS = os.environ.get("SCRIBD_SHOTS", "").rstrip("/")
# The browser service is not deployed beside this panel: it is its own server,
# on its own host, with its own assigned endpoint. So every door it could be
# behind is written down here instead of wired by hand — tried in order, and the
# first one that answers `"ok": true` is the browser. SCRIBD_SHOTS still comes
# first when it is set, for a box that is not this box, but nothing needs setting.
#   127.0.0.1 / localhost   the same container, or the same machine. Asked first
#                           because a door with nobody behind it answers at once,
#                           and one box does run both halves together.
#   node6.botkeep.cloud:45009
#                           THE browser egg. Its own control panel names this as
#                           the endpoint assigned to it, so this — not any port
#                           of this panel's machine — is the door to knock on.
#   77.90.45.110:45009      the same door by number, for a container whose name
#                           service cannot resolve the host above.
#   195.123.189.187         this panel's own address, kept for the day the two
#                           eggs share a machine again, and asked last: a port
#                           nobody answers there costs the whole timeout.
SHOT_HOSTS = ("http://127.0.0.1:8096", "http://localhost:8096",
              "http://node6.botkeep.cloud:45009",
              "http://77.90.45.110:45009",
              "http://195.123.189.187:8096",
              "http://195.123.189.187:25811")
# The door a copy started beside this panel takes. Read off the first address
# above, so starting one can never put the browser somewhere nobody looks.
SHOT_LOCAL_PORT = int(urllib.parse.urlparse(SHOT_HOSTS[0]).port or 8096)
# A server cannot see the public port its own panel mapped to it, so if every
# written-down door is shut, this one asks the browser egg's host port by port —
# once — and remembers the answer in shooter-found.txt. The endpoint above is
# today's; a host that moves it to another port is still found, with no setting
# to touch and no second sweep ever.
SHOOTER_SCAN_RANGES = ((25000, 26000), (20000, 30000), (44000, 46000))
_scan_host = os.environ.get("SCRIBD_SHOOTER_HOST", "").strip()
# (host, the bands of its ports to ask), in the order worth asking them: the
# narrow shelf around the endpoint it has today first, because a host that hands
# out ports from one shelf is found in about a hundred questions.
SHOOTER_SCAN_HOSTS = (((_scan_host, SHOOTER_SCAN_RANGES),) if _scan_host else
                      (("node6.botkeep.cloud", ((45000, 45100), (44000, 46000))),
                       ("77.90.45.110", ((45000, 45100), (44000, 46000))),
                       ("195.123.189.187", ((25000, 26000), (20000, 30000)))))
SCAN_RETRY_AFTER = 900.0    # a sweep that found nothing is not repeated at once
SCAN_BUDGET = 120.0         # the most a sweep may take: documents are waiting
SCAN_LIE_RATIO = 4          # a host that says yes to every 4th port is lying
_SCAN_LOCK = threading.Lock()
_SCAN_TRIED: dict = {"when": 0.0}
SHOT_FOUND_FOR = 300.0      # a service that answered is trusted for this long
SHOT_RETRY_AFTER = 60.0     # one that did not is looked for again after this
_SHOT_CACHE: dict = {"base": "", "note": "", "when": 0.0}
_SHOT_LOCK = threading.Lock()
# 1x is standard quality: the page at the size the viewer draws it. 2x was the
# same page at twice the detail — four times the pixels to draw, encode, send
# and embed, for a sheet that is placed at the same size in the PDF anyway.
SHOT_SCALE = float(os.environ.get("SCRIBD_SHOT_SCALE") or 1)
SHOT_TIMEOUT = float(os.environ.get("SCRIBD_SHOT_TIMEOUT") or 120)
# Every page of every document is a photograph now, so this is no longer a cap on
# a rescue — it is a cap on a WHOLE BOOK going page by page. One pass over the
# viewer is what makes a long book fast; this bounds the slow route behind it, for
# the book whose column the pass could not cut at all. A cap below the longest book
# on the shelf is a book that comes out short — named, but short — so it sits above
# every book asked for so far (the longest is 402), and 2000 pages one at a time
# over 8 tabs is still a wait of minutes, not hours.
MAX_SHOT_PAGES = 2000
MAX_SHOT_JOBS = 8           # tabs in one browser: past this it stops helping
