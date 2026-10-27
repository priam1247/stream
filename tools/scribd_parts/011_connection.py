

def _connection(scheme: str, netloc: str, timeout: float):
    pool = getattr(_POOL, "pool", None)
    if pool is None:
        pool = _POOL.pool = {}
    connection = pool.get((scheme, netloc))
    if connection is None:
        factory = (http.client.HTTPSConnection if scheme == "https"
                   else http.client.HTTPConnection)
        connection = factory(netloc, timeout=timeout)
        pool[(scheme, netloc)] = connection
    return connection
