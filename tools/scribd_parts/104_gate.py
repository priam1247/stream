
class Gate:
    """A shared token bucket that tells the two kinds of refusal apart.

    A 429/503 is the CDN throttling: pay 30% of the rate. A 403 is a key that
    will 403 however slowly it is asked for, so it only costs 3%.
    """

    def __init__(self, rate: float = 24.0, floor: float = 8.0,
                 ceiling: float = 60.0) -> None:
        self.lock = threading.Lock()
        self.rate = rate
        self.floor = floor
        self.ceiling = ceiling
        self.tokens = 10.0
        self.stamp = time.time()
        self.clean = 0

    def acquire(self) -> None:
        while True:
            with self.lock:
                now = time.time()
                self.tokens = min(16.0, self.tokens + (now - self.stamp) * self.rate)
                self.stamp = now
                if self.tokens >= 1.0:
                    self.tokens -= 1.0
                    return
                wait = (1.0 - self.tokens) / self.rate
            time.sleep(min(wait, 0.2))

    def clean_answer(self) -> None:
        with self.lock:
            self.clean += 1
            if self.clean >= 4:
                self.clean = 0
                self.rate = min(self.ceiling, self.rate * 1.03)

    def complaint(self, status: int) -> None:
        with self.lock:
            if status in HARD_THROTTLE:
                self.clean = 0
                self.rate = max(self.floor, self.rate * 0.70)
            else:
                self.rate = max(self.floor, self.rate * 0.97)
