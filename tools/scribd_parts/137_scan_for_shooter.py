

def scan_for_shooter(host: str = "", announce=None) -> str:
    """Find the browser egg by asking its host's ports, once.

    The egg cannot say which port its own panel mapped to it, and nothing on
    this machine is it, so the ports are asked directly: a closed one answers at
    once, so a band of a thousand costs a couple of seconds even across a
    network. The first address that answers /shot/ping with ok:true is the
    browser, and it is written to shooter-found.txt so no later run, and no
    later restart, ever sweeps again. A sweep that finds nothing is not repeated
    for SCAN_RETRY_AFTER, so an egg that is simply stopped cannot slow down
    every document that asks for it.
    """
    say = announce or (lambda text: JOB.say(text))
    with _SCAN_LOCK:
        cached = read_shooter_cache()
        if cached and ping_ok(cached, 3.0):
            return cached
        if time.time() - _SCAN_TRIED["when"] < SCAN_RETRY_AFTER:
            return ""
        targets = (((host, SHOOTER_SCAN_RANGES),) if host
                   else SHOOTER_SCAN_HOSTS)
        found = ""
        ran_out = ""
        deadline = time.time() + SCAN_BUDGET
        for name, bands in targets:
            if time.time() >= deadline:
                ran_out = name
                break
            try:                       # a name is looked up once, not per port
                address = socket.gethostbyname(name)
            except OSError:
                say(f"cannot look up the name {name}, so its ports cannot be "
                    f"asked")
                continue
            for low, high in bands:
                if time.time() >= deadline:
                    ran_out = ran_out or name
                    break
                open_ports: list[int] = []

                def try_port(port: int, where: str = address) -> int | None:
                    sock = socket.socket()
                    sock.settimeout(0.5)   # a host across a network, not a
                    try:                   # container next door: it needs room
                        return (port if sock.connect_ex((where, port)) == 0
                                else None)
                    except Exception:                      # noqa: BLE001
                        return None
                    finally:
                        sock.close()

                with ThreadPoolExecutor(max_workers=200) as pool:
                    for port in pool.map(try_port, range(low, high + 1)):
                        if port:
                            open_ports.append(port)
                if len(open_ports) * SCAN_LIE_RATIO > high - low + 1:
                    # every door "open" is a host, or a firewall in front of it,
                    # that says yes to everything — which is no answer about any
                    # one port. Asking them all would take the rest of the day.
                    say(f"{name} answered on {len(open_ports)} of "
                        f"{high - low + 1} ports asked — a host that opens "
                        f"every door is not telling the truth about any of "
                        f"them, so they are not asked one by one")
                    continue
                for port in sorted(open_ports):
                    base = f"http://{name}:{port}"
                    if ping_ok(base, 5.0):
                        found = base
                        break
                if found:
                    break
            if found:
                break
        _SCAN_TRIED["when"] = time.time()
    if found:
        write_shooter_cache(found)
        say(f"found the browser service at {found} by asking its host's ports "
            f"once — remembered in tools/shooter-found.txt, never swept again")
    elif ran_out:
        say(f"the search for the browser service ran out of its "
            f"{int(SCAN_BUDGET)} seconds at {ran_out} — pages will come as "
            f"words until it is found, and its ports are not asked again for "
            f"{int(SCAN_RETRY_AFTER // 60)} minutes")
    else:
        say(f"asked {', '.join(name for name, _b in targets)} port by port and "
            f"no port is the browser service — pages will come as words until "
            f"that egg is running, and its ports are not asked again for "
            f"{int(SCAN_RETRY_AFTER // 60)} minutes")
    return found
