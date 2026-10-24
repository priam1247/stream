from __future__ import annotations

import re

from bs4 import BeautifulSoup, NavigableString, Tag

BLOCK_TAGS = {
    "p", "div", "section", "article", "header", "footer", "main", "aside",
    "blockquote", "pre", "table", "tr", "ul", "ol", "li", "h1", "h2", "h3",
    "h4", "h5", "h6", "hr", "figure", "figcaption", "dl", "dt", "dd",
}
SKIP_TAGS = {"script", "style", "noscript", "svg", "head", "meta", "link"}
BOLD_RE = re.compile(r"font-weight\s*:\s*(?:bold|[6-9]\d\d)", re.I)
ITALIC_RE = re.compile(r"font-style\s*:\s*italic", re.I)


def _style_of(tag: Tag) -> str:
    style = tag.get("style") or ""
    cls = " ".join(tag.get("class") or [])
    return f"{style} {cls}"


def _walk(node, out: list[str], md: bool) -> None:
    for child in node.children:
        if isinstance(child, NavigableString):
            out.append(str(child))
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name.lower()
        if name in SKIP_TAGS:
            continue
        if name == "br":
            out.append("\n")
            continue
        if name == "hr":
            out.append("\n" + "-" * 24 + "\n")
            continue

        style = _style_of(child)
        bold = md and bool(BOLD_RE.search(style))
        italic = md and bool(ITALIC_RE.search(style))
        if bold:
            out.append("**")
        if italic:
            out.append("*")

        if name in BLOCK_TAGS:
            out.append("\n")
            if name == "li":
                out.append("- ")
            _walk(child, out, md)
            out.append("\n")
            if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
                out.append("\n")
        elif name in ("td", "th"):
            _walk(child, out, md)
            out.append(" | ")
        else:
            _walk(child, out, md)

        if italic:
            out.append("*")
        if bold:
            out.append("**")


def clean_text(text: str) -> str:
    text = text.translate(
        dict.fromkeys(map(ord, "\u200b\u200c\u200d\ufeff\u00ad"), None)
    )
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    return text.strip()


def _render(fragment: str, md: bool) -> str:
    if not fragment or not fragment.strip():
        return ""
    soup = BeautifulSoup(fragment, "lxml")
    out: list[str] = []
    _walk(soup, out, md)
    text = clean_text("".join(out))
    if md:
        text = re.sub(r"\*{4,}", "**", text)
        text = re.sub(r"\*\s+\*", " ", text)
    return text


def html_to_text(fragment: str) -> str:
    return _render(fragment, md=False)


def html_to_markdown(fragment: str) -> str:
    return _render(fragment, md=True)
