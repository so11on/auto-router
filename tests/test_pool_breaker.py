"""SEC-16: the free-pool circuit breaker and what the router does while it is open."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_router_hook as base  # noqa: E402  (stubs litellm, sets env)

h = base.h
pool = h.pool


class Breaker(unittest.TestCase):
    def test_opens_after_threshold_in_window_and_closes_on_success(self):
        b = pool.Breaker(3, 60, 300)
        for t in (0, 10, 20):
            self.assertFalse(b.is_open(t))
            b.record(False, "timeout", now=t)
        self.assertTrue(b.is_open(21))
        self.assertEqual(b.status(21)["state"], "unhealthy")
        self.assertTrue(b.is_open(319))
        self.assertFalse(b.is_open(321), "half-open after the cooldown")
        b.record(True, now=322)
        self.assertEqual(b.status(323)["state"], "healthy")

    def test_failures_outside_the_window_do_not_add_up(self):
        b = pool.Breaker(3, 60, 300)
        for t in (0, 100, 200, 300):
            b.record(False, now=t)
        self.assertFalse(b.is_open(301))

    def test_only_pool_groups_are_covered(self):
        self.assertTrue(pool.Breaker.covers("free-pool-fast"))
        self.assertFalse(pool.Breaker.covers("pool-gpt-oss-120b"))
        self.assertFalse(pool.Breaker.covers("gemini-flash"))


class HookWithPoolDown(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ("SAFETY_MODE", "SENSITIVE_GUARD", "AR_DATA_DIR")}
        self.tmp = tempfile.mkdtemp()
        with open(os.path.join(self.tmp, "pool-members.json"), "w") as f:  # a verified, safe pool
            json.dump({c: [{"id": "groq/x", "privacy": "no_retention"}] for c in ("free-fast", "free-coding")}, f)
        os.environ["AR_DATA_DIR"] = self.tmp
        h.FREE_POOL_ENABLED = True
        h._sticky.clear()
        h._last_model.clear()
        h._breaker.failures.clear()
        h._breaker.open_until = 0.0

        async def fake(text, *a, **k):
            return {"task": "codegen", "complexity": 3}
        h._classify = fake
        self.calls = []
        h.litellm.acompletion = None if not hasattr(h.litellm, "acompletion") else h.litellm.acompletion

    def tearDown(self):
        h.FREE_POOL_ENABLED = True
        h._breaker.open_until = 0.0
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def call(self, model):
        import asyncio
        data = {"model": model, "messages": [{"role": "user", "content": "hello"}]}
        return asyncio.run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, "completion"))

    def test_free_with_pool_down_and_safety_on_is_blocked_with_a_clear_message(self):
        os.environ["SAFETY_MODE"] = "on"
        h._breaker.open_until = 10 ** 12
        with self.assertRaises(h.HTTPException) as cm:
            self.call("auto-free")
        self.assertEqual(cm.exception.status_code, 503)
        self.assertIn("pool gratuito está indisponível", str(cm.exception.detail))

    def test_free_with_pool_down_and_safety_off_uses_only_the_free_gemini_never_paid(self):
        os.environ["SAFETY_MODE"] = "off"
        h._breaker.open_until = 10 ** 12
        d = self.call("auto-free")
        self.assertEqual(d["model"], "gemini-free-flash-lite")
        self.assertTrue(all(h._is_free_model(m) for m in d["fallbacks"]))

    def test_balanced_skips_a_dead_pool_without_waiting(self):
        h._breaker.open_until = 10 ** 12
        d = self.call("auto-balanced")
        self.assertFalse(d["model"].startswith("free-pool"))
        self.assertFalse(any(m.startswith("free-pool") for m in d["fallbacks"]))


if __name__ == "__main__":
    unittest.main()
