"""Circuit breaker for the free pool (SEC-16). Pure Python, no LiteLLM import.

The pool is one OmniRoute instance behind three model groups (free-pool, free-pool-fast, free-pool-coding): when it is
down or misbehaving, every group fails together. After THRESHOLD failures within WINDOW seconds the breaker opens for
COOLDOWN seconds and the router skips the pool immediately instead of waiting for the 15 s timeout on every request.
When the cooldown ends one request is let through (half-open); a success closes the breaker, a failure reopens it.
"""
import os
import time
from collections import deque

POOL_PREFIX = "free-pool"


def _num(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


class Breaker:
    def __init__(self, threshold: int = None, window_s: float = None, cooldown_s: float = None):
        self.threshold = int(threshold if threshold is not None else _num("POOL_FAIL_THRESHOLD", 3))
        self.window_s = window_s if window_s is not None else _num("POOL_FAIL_WINDOW_S", 60)
        self.cooldown_s = cooldown_s if cooldown_s is not None else _num("POOL_COOLDOWN_S", 300)
        self.failures = deque()
        self.open_until = 0.0
        self.last_error = ""

    @staticmethod
    def covers(model: str) -> bool:
        return str(model).startswith(POOL_PREFIX)

    def record(self, ok: bool, error: str = "", now: float = None) -> None:
        now = time.time() if now is None else now
        if ok:
            self.failures.clear()
            self.open_until = 0.0
            return
        self.last_error = (error or "failed")[:160]
        self.failures.append(now)
        while self.failures and now - self.failures[0] > self.window_s:
            self.failures.popleft()
        if len(self.failures) >= self.threshold:
            self.open_until = now + self.cooldown_s
            self.failures.clear()

    def is_open(self, now: float = None) -> bool:
        now = time.time() if now is None else now
        return now < self.open_until

    def status(self, now: float = None) -> dict:
        now = time.time() if now is None else now
        if self.is_open(now):
            return {"state": "unhealthy", "reopens_in_s": round(self.open_until - now), "reason": self.last_error}
        return {"state": "healthy", "recent_failures": len(self.failures)}
