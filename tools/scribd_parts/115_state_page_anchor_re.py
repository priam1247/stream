

# ---------------------------------------------------------------------------
# the embed viewer's own pages — where the words are when no descriptor is
# ---------------------------------------------------------------------------
# This is the piece v2.17 did not have. A converted document (a Word file, a
# typed book) has no scan for most of its pages, and its `.jsonp` descriptor is
# sometimes not served either: the only place the words exist is the page a
# browser reads, `/embeds/<id>/content?start_page=1&view_mode=scroll`, where
# every page is an HTML block with its text already in it.
# A browser reads that page anonymously for public documents, which is why the
# document looks complete on Scribd and used to come out blank here.
PAGE_ANCHOR_RE = re.compile(
    r'id="(?:outer_)?page[-_]?(\d+)"'
    r'|data-page-number="(\d+)"'
    r'|data-page="(\d+)"'
    r'|id="page-(\d+)"', re.IGNORECASE)
SCRIPT_BLOCK_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>",
                             re.IGNORECASE | re.DOTALL)
# The viewer wraps every page in furniture: an ad, "Share this document", the
# cookie notice, the sign-up banner. Those lines are not the book and must not
# be drawn onto a sheet as if they were.
BOILERPLATE = (
    "download to read ad-free", "opens in a new window", "opening in a new window",
    "opens an external website", "you are on page", "share this document",
    "copy link", "share on facebook", "share on linkedin", "share with email",
    "sign in", "sign up", "log in", "free trial", "privacy policy",
    "your privacy choices", "close this consent banner", "skip to main content",
    "open navigation menu", "close suggestions", "change language",
    "found this document useful", "uploaded by", "millions of documents",
    "ad-free", "scribd.com/oauth", "follow this publisher", "related documents",
    "report this document", "about scribd", "cookie", "advertisement",
)
BOILERPLATE_JUNK = {"ad", "ads", "advert", "scribd", "download", "menu",
                    "search", "searchsearch", "share", "save", "print"}
