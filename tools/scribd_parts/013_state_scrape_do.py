
# The scrape route: a second door for the moments Scribd's front door refuses
# the address this panel runs on (a 403 that is about the address, not about the
# page). Direct requests stay first and carry the session; the route is asked
# only after a refusal, only for Scribd's own public hosts, never in local
# tests, and at most SCRAPE_BUDGET times per document so a blocked address
# cannot spend the route's quota forever. It carries NO cookies — the tokens a
# page needs ride inside the URL, and a session is not a thing to hand a
# third party. SCRIBD_SCRAPE_DO replaces the written-down token; an empty one
# ("SCRIBD_SCRAPE_DO=") closes the door altogether.
SCRAPE_DO = os.environ.get("SCRIBD_SCRAPE_DO",
                           "08f4411be1ab4315a77eabfa981d4f3f277af459e57").strip()
SCRAPE_REFUSED = (403, 429, 503)
SCRAPE_BUDGET = 40
SCRAPE_HOSTS = ("scribd.com", "scribdassets.com")
_scrape_left = [SCRAPE_BUDGET]
_scrape_lock = threading.Lock()
_scrape_said = [False]
