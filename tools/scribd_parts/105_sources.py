
class Sources:
    """page number -> the names seen for it, in the order seen.

    A list, not one name: the document's own name stays first (so good pages
    still cost one request) and a descriptor's name is appended behind it, so a
    stale name can never evict a working one.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.images: dict[int, list[str]] = {}
        self.jsonps: dict[int, list[str]] = {}
        self.folders: set[str] = set()

    @staticmethod
    def _add(table: dict[int, list[str]], number: int, url: str) -> bool:
        url = full_url(url)
        if not url:
            return False
        bucket = table.setdefault(number, [])
        if url in bucket:
            return False
        bucket.append(url)
        return True

    def merge(self, body: bytes) -> int:
        text = text_of(body)
        changed = 0
        with self.lock:
            for match in JSONP_RE.finditer(text):
                if self._add(self.jsonps, int(match.group(1)), match.group(0)):
                    changed += 1
            for match in IMAGE_RE.finditer(text):
                if self._add(self.images, int(match.group(1)), match.group(0)):
                    changed += 1
        return changed

    def get(self, number: int) -> dict[str, str]:
        with self.lock:
            images = self.images.get(number) or []
            jsonps = self.jsonps.get(number) or []
            return {"image": images[0] if images else "",
                    "jsonp": jsonps[0] if jsonps else ""}

    def images_for(self, number: int) -> list[str]:
        with self.lock:
            return list(self.images.get(number) or [])

    def asset_patterns(self) -> list[str]:
        """One asset name of every shape this document writes, any page."""
        with self.lock:
            seen: set[str] = set()
            out: list[str] = []
            for urls in list(self.images.values()) + list(self.jsonps.values()):
                for url in urls:
                    shape = re.sub(r"/\d+-[0-9A-Za-z]+\.", "/#.", url.split("?")[0])
                    if shape not in seen:
                        seen.add(shape)
                        out.append(url)
            return out

    def jsonps_for(self, number: int) -> list[str]:
        with self.lock:
            return list(self.jsonps.get(number) or [])

    def count(self) -> int:
        with self.lock:
            return len(set(self.images) | set(self.jsonps))

    def highest(self) -> int:
        with self.lock:
            both = set(self.images) | set(self.jsonps)
            return max(both) if both else 0
