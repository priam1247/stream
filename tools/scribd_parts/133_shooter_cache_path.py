

def shooter_cache_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "shooter-found.txt")
