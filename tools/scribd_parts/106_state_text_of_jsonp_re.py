
TEXT_OF_JSONP_RE = re.compile(r"^\s*(?:window\.)?[A-Za-z0-9_$.]*call?back?\s*\(|"
                              r"^\s*[A-Za-z0-9_$.]+\s*\(", re.I)
BREAK_TAG_RE = re.compile(r"<\s*(?:br|/p|/div|/li|/h[1-6]|/tr)\s*/?\s*>", re.I)
TAG_STRIP_RE = re.compile(r"<[^>]*>")
SPACE_RE = re.compile(r"[ \t\u00a0]+")
