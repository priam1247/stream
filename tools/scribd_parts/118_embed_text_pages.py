

def embed_text_pages(body: bytes) -> dict[int, str]:
    """Every page's words out of the embed viewer, by page number.

    The viewer marks each page's block with its number (`id="page-3"`,
    `data-page-number="3"`, …). Slicing the page at those marks is what keeps
    page 34's words on sheet 34 instead of dumping all 38 pages onto one.
    """
    text = SCRIPT_BLOCK_RE.sub(" ", text_of(body))
    marks: list[tuple[int, int]] = []
    seen: set[int] = set()
    for match in PAGE_ANCHOR_RE.finditer(text):
        digits = next((group for group in match.groups() if group), "")
        if not digits.isdigit():
            continue
        number = int(digits)
        if number in seen or number == 0:
            continue
        seen.add(number)
        marks.append((match.start(), number))
    if not marks:
        # some viewers print no page number at all, only a text block per page
        blocks = [m.start() for m in re.finditer(r'class="[^"]*text_layer',
                                                 text, re.IGNORECASE)]
        if len(blocks) >= 3:
            marks = [(position, index + 1)
                     for index, position in enumerate(blocks)]
        else:
            return {}
    marks.sort()

    def tag_start(position: int) -> int:
        """Where the tag around this mark begins, so no half tag leaks in.

        A mark is an attribute inside `<div id="page-3" …>`. Cutting at the mark
        itself leaves `id="page-3" class="outer_page"` behind, and the tag
        stripper cannot remove a fragment that has no `<` in front of it.
        """
        opened = text.rfind("<", 0, position)
        return opened if opened >= 0 else position

    pages: dict[int, str] = {}
    for index, (start, number) in enumerate(marks):
        end = tag_start(marks[index + 1][0]) if index + 1 < len(marks) else len(text)
        words = lines_from_html(text[tag_start(start):end], chrome=True)
        if words.strip():
            pages[number] = words
    return pages
