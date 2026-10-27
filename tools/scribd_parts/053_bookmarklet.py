

def bookmarklet(origin: str) -> str:
    """The one-bookmark route: your browser finds, the panel downloads.

    Built server-side from the address you actually opened the panel on, so the
    link always points back at this panel — never at scribd.com.
    """
    target = (origin or "").rstrip("/") + "/send?"
    if PANEL_KEY:
        target += "key=" + urllib.parse.quote(PANEL_KEY, safe="") + "&"
    return ("javascript:(()=>{const o=" + json.dumps(target) + ";"
            "const sel='a[href*=\"/document/\"],a[href*=\"/presentation/\"],'"
            "+'a[href*=\"/spreadsheet/\"],a[href*=\"/ebook/\"]';"
            "const u=[...document.querySelectorAll(sel)]"
            ".map(a=>a.href.split('?')[0]).filter((v,i,s)=>s.indexOf(v)===i)"
            ".slice(0,40);"
            "if(!u.length){alert('no document links on this page');return}"
            "location.href=o+u.map(x=>'url='+encodeURIComponent(x)).join('&')})()")
