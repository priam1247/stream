

def page_count(body: bytes, sources: Sources) -> int:
    text = text_of(body)
    for pattern in (r'"page_count"\s*:\s*(\d+)', r'"totalPages"\s*:\s*(\d+)',
                    r'"pageCount"\s*:\s*(\d+)', r'"pages_count"\s*:\s*(\d+)'):
        match = re.search(pattern, text)
        if match:
            return int(match.group(1))
    return sources.highest()
