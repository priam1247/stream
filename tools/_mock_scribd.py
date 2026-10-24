#!/usr/bin/env python3
"""Local stand-in for Scribd, to test the panel end to end without the network.

  GET /document/<id>   document html naming 2 pages
  GET /embeds/<id>     the viewer shell
  GET /images/...      a small synthetic page scan
  GET /services/oembed title/author
  GET /search/query    Scribd's own search answer (2 documents, then nothing)
"""
import json
import struct
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8910

def fake_jpeg(width=1200, height=1600, fill=6000):
    out = bytearray(b"\xff\xd8")
    out += b"\xff\xc0" + struct.pack(">H", 11) + bytes([8])
    out += struct.pack(">HH", height, width) + bytes([3]) + b"\x00" * 6
    out += b"\xff\xda" + b"\x00\x08" + b"\x00" * 6
    out += bytes((index * 7) % 256 for index in range(fill))
    out += b"\xff\xd9"
    return bytes(out)


def document_html(doc_id):
    return (f'<!doctype html><html><head>'
            f'<meta property="og:title" content="Doc {doc_id} | Scribd">'
            f'</head><body><script>var d={{"page_count":2}};'
            f'var p1="https:\\\\/\\\\/html.scribdassets.com\\\\/h{doc_id}'
            f'\\\\/images\\\\/1-aa{doc_id}.jpg";'
            f'var p2="https:\\\\/\\\\/html.scribdassets.com\\\\/h{doc_id}'
            f'\\\\/images\\\\/2-bb{doc_id}.jpg";'
            f'</script></body></html>').encode()


def search_answer(query, page):
    """The shape Scribd really returns: results.documents.content.documents."""
    documents = []
    if page == 1:
        documents = [
            {"id": 900001, "title": f"{query} question bank", "pageCount": 2,
             "views": "1.2K", "releasedAt": "2025-01-01",
             "reader_url": "https://www.scribd.com/document/900001/Question-Bank",
             "authors": [{"id": 1, "name": "someone"}]},
            {"id": 900001, "title": "duplicate of the first",
             "pageCount": 2,
             "reader_url": "https://www.scribd.com/document/900001/Question-Bank"},
            {"id": 900002, "title": f"{query} notes", "pageCount": 2,
             "views": "40",
             "reader_url": "https://www.scribd.com/document/900002/Notes",
             "authors": [{"id": 2, "name": "someone else"}]},
            {"id": 900003, "title": "not scribd",
             "reader_url": "https://example.com/document/900003"},
        ]
    return {"compilationId": "mock", "content_type": "documents",
            "results": {"documents": {"content": {"documents": documents}}}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send(self, body, code=200, ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/search/query":
            query = urllib.parse.parse_qs(self.path.split("?")[1])
            words = (query.get("query") or [""])[0]
            if "refused" in words.lower():
                self.send(b"no", 403, "text/plain")
                return
            page = int((query.get("page") or ["1"])[0])
            self.send(json.dumps(search_answer(words, page)).encode(),
                      ctype="application/json")
        elif path.startswith("/document/"):
            self.send(document_html(path.split("/")[2]))
        elif path.startswith("/embeds/"):
            self.send(b"<html>embed</html>")
        elif path.startswith("/services/oembed"):
            self.send(b'{"title":"Doc","author_name":"someone"}',
                      ctype="application/json")
        elif "/images/" in path:
            self.send(fake_jpeg(), ctype="image/jpeg")
        else:
            self.send(b"not found", 404, "text/plain")


if __name__ == "__main__":
    print(f"mock scribd on {PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
