

# ---------------------------------------------------------------------------
# lines: the shape a browser actually lays out
# ---------------------------------------------------------------------------
# Scribd's page HTML is not a paragraph. Each line is its own element, placed
# with inline CSS (`<span style="left:12%;top:34%">…`), and the tags carry the
# only clue that a new line starts at all: strip them and the page becomes one
# long run — a contents page turned into a paragraph in the corner of the
# sheet. So the positioned elements are read for their vertical place, and the
# page keeps its lines and their spacing.
LINE_MARK = "\x01"           # "the line after this mark has a vertical place"
WORDS_CACHE_TAG = "#words-v2"   # a cached page written with line placement
STYLE_TAG_RE = re.compile(r"<(span|div|p|li|td|a|h[1-6])\b([^>]*)>", re.IGNORECASE)
STYLE_ATTR_RE = re.compile(r"""style\s*=\s*["']([^"']*)["']""", re.IGNORECASE)
TOP_RE = re.compile(r"top\s*:\s*(-?[\d.]+)\s*(px|pt|em|%|in)?", re.IGNORECASE)
