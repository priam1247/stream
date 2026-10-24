from __future__ import annotations

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
]

BASE_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
}

DOC_HOST = "https://www.scribd.com"
EMBED_URL = DOC_HOST + "/embeds/{doc_id}/content?start_page=1&view_mode=scroll"
OEMBED_URL = DOC_HOST + "/services/oembed?url={quoted}&format=json"
RENDER_META_URL = DOC_HOST + "/doc-page/download-render-metadata/{doc_id}"
DOWNLOAD_PDF_URL = DOC_HOST + "/document_downloads/{doc_id}?extension=pdf&source=doc_page"

RETRY_STATUS = {408, 425, 429, 500, 502, 503, 504, 520, 522, 524}
# 403 is handled separately in Fetcher.get: it may be a transient
# bot-wall, so it is retried (with UA rotation) rather than returned.
RETRY_WITH_UA_ROTATION = {403, 429}
