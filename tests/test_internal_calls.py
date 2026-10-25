"""SEC-05: classifier / checkpoint / summary calls obey the profile, SAFETY_MODE and the sensitive-class rules."""
import asyncio
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_router_hook as base  # noqa: E402  (stubs litellm, sets env)

h = base.h
REAL_CLASSIFY = h._classify  # other test classes swap in fakes at run time
ENV = ("SAFETY_MODE", "AR_DATA_DIR", "GEMINI_API_KEY")


class InternalCalls(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV}
        self.tmp = tempfile.mkdtemp()
        with open(os.path.join(self.tmp, "pool-members.json"), "w") as f:
            json.dump({c: [{"id": "groq/x", "privacy": "no_retention"}] for c in ("free-fast", "free-coding")}, f)
        os.environ.update(AR_DATA_DIR=self.tmp, SAFETY_MODE="on", GEMINI_API_KEY="paid-key")
        self.calls = []

        async def spy(**kw):
            self.calls.append(kw)
            raise RuntimeError("no network in tests")
        h.litellm.acompletion = spy
        h._classify = REAL_CLASSIFY

    def tearDown(self):
        h.FREE_POOL_ENABLED = False
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def s(self, **over):
        return {**h.safety.settings(), **over}

    def test_free_mode_never_uses_a_paid_key_when_the_pool_is_off(self):
        h.FREE_POOL_ENABLED = False
        self.assertIsNone(h._internal_route("free", self.s(), False))
        self.assertEqual(h._heuristic("fix the bug")["source"], "heuristic")
        with self.assertRaises(RuntimeError):
            asyncio.run(h._llm_json(h._internal_route("free", self.s(), False), "sys", "text", 10))
        self.assertEqual(self.calls, [], "litellm.acompletion must not be called")

    def test_free_mode_uses_the_pool_only_when_enabled_healthy_and_allowed(self):
        h.FREE_POOL_ENABLED = True
        self.assertEqual(h._internal_route("free", self.s(), False), "pool")
        h._breaker.open_until = 10 ** 12
        try:
            self.assertIsNone(h._internal_route("free", self.s(), False))
        finally:
            h._breaker.open_until = 0.0
        self.assertIsNone(h._internal_route("free", self.s(), True), "no_retention pool may not see sensitive text")

    def test_balanced_uses_the_paid_classifier_for_normal_text_but_not_when_unsafe_or_sensitive(self):
        h.FREE_POOL_ENABLED = False
        self.assertEqual(h._internal_route("balanced", self.s(), False), "paid")
        self.assertEqual(h._internal_route("balanced", self.s(), True), "paid", "a paid (trusted) key may see sensitive text")
        os.environ.pop("GEMINI_API_KEY")
        self.assertIsNone(h._internal_route("balanced", self.s(), False), "without the paid key the gemini string is unsafe")
        self.assertEqual(h._internal_route("balanced", self.s(safety_mode="off"), False), "paid")

    def test_text_sent_to_the_classifier_is_capped(self):
        sent = []

        async def spy(**kw):
            sent.append(kw["messages"][1]["content"])
            raise RuntimeError("stop")
        h.litellm.acompletion = spy
        asyncio.run(h._classify("x" * 50000, "balanced", s=self.s(), sensitive=False))
        self.assertEqual(len(sent), 1)
        self.assertLessEqual(len(sent[0]), h.CLASSIFIER_MAX_CHARS)


if __name__ == "__main__":
    unittest.main()


class MemoryMasking(unittest.TestCase):
    def test_secrets_and_personal_data_never_reach_the_memory_file(self):
        key = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"
        out = h._mask_for_memory(f"## Summary\nuser pasted {key} and cpf 529.982.247-25, mail ana@empresa.com.br")
        for leaked in (key, "529.982.247-25", "ana@empresa.com.br"):
            self.assertNotIn(leaked, out)
        self.assertIn("SECRET_1", out)
