

def documents_in(payload) -> list:
    """The list of documents inside Scribd's answer, wherever it is nested."""
    node = payload
    for key in ("results", "documents", "content", "documents"):
        node = node.get(key) if isinstance(node, dict) else None
        if node is None:
            break
    if isinstance(node, list):
        return [item for item in node if isinstance(item, dict)]
    # the shape moved? take the first list of documents that names a reader_url
    queue = [payload]
    while queue:
        item = queue.pop(0)
        if isinstance(item, dict):
            queue.extend(item.values())
        elif isinstance(item, list):
            if any(isinstance(x, dict) and "reader_url" in x for x in item[:5]):
                return [x for x in item if isinstance(x, dict)]
            queue.extend(item)
    return []
