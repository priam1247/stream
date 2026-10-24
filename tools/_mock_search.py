#!/usr/bin/env python3
"""Local stand-in for the search engines + Scribd, to test v2.5 end to end.

  POST /html/         DuckDuckGo html endpoint -> 202 (this address is blocked)
  POST /lite/         DuckDuckGo lite          -> 202 (blocked)
  GET  /search?q=     Bing                     -> 3 result links, one duplicate
  GET  /document/<id>                          -> document html naming 2 pages
  GET  /images/...                             -> a small synthetic page scan
"""
import struct
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8910

BING = b"""<!doctype html><html><body><ol>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=aa&u=aXBsYWNlaG9sZGVy">x</a></h2>
  <a href="https://www.scribd.com/document/750213011/Physics-12th">Physics 12th question bank</a>
  <cite>https://www.scribd.com/document/750213011/Physics-12th</cite></li>
<li class="b_algo"><a href="https://www.scribd.com/document/750213011/Physics-12th">Save</a></li>
<li class="b_algo"><a href="https://www.scribd.com/document/804179430/Book-List">CBSE book list 2024</a></li>
<li class="b_algo"><a href="https://www.scribd.com/presentation/700000001/Chemistry">Chemistry slides</a></li>
<li><a href="https://www.scribd.com/about">About Scribd</a></li>
</ol></body></html>"""


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

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        # both DuckDuckGo endpoints refuse this address, like a datacenter IP
        self.send(b"<html>blocked</html>", 202)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/search":
            self.send(BING)
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
    print(f"mock engines + scribd on {PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
