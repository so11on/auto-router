"""SEC-08: DLP + safety filters inside the pre-call hook (offline, LiteLLM stubbed)."""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_router_hook as base  # noqa: E402  (stubs litellm, sets env)

h = base.h
KEY = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"
ENV = ("SAFETY_MODE", "SENSITIVE_GUARD", "SENSITIVE_MASK_SECRETS", "SENSITIVE_ALLOWED_CLASSES")


class HookSafety(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV}
        os.environ.update(SAFETY_MODE="on", SENSITIVE_GUARD="on", SENSITIVE_MASK_SECRETS="on", SENSITIVE_ALLOWED_CLASSES="trusted")
        h._sticky.clear()
        h._last_model.clear()
        self.seen = []

        async def fake(text, *a, **k):
            self.seen.append(text)
            return {"task": "codegen", "complexity": 3}
        h._classify = fake

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def call(self, model, text):
        data = {"model": model, "messages": [{"role": "user", "content": text}]}
        return asyncio.run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, "completion"))

    def test_secret_is_masked_and_never_reaches_the_classifier(self):
        d = self.call("auto-balanced", f"fix this, key {KEY}")
        self.assertNotIn(KEY, repr(d))
        self.assertTrue(all(KEY not in t for t in self.seen))
        meta = d["metadata"]["auto_router"]
        self.assertTrue(meta["sensitive"])
        self.assertEqual(meta["dlp"]["secrets"], 1)
        self.assertNotIn(KEY, repr(meta))

    def test_sensitive_uses_only_trusted_models_and_filtered_fallbacks(self):
        d = self.call("auto-balanced", f"key {KEY}")
        meta = d["metadata"]["auto_router"]
        for name in [d["model"]] + meta["fallbacks"]:
            self.assertEqual(h.safety.privacy_of(name), "trusted", name)

    def test_sensitive_free_mode_is_blocked_with_a_clear_message(self):
        with self.assertRaises(h.HTTPException) as cm:
            self.call("auto-free", f"key {KEY}")
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("sensível", str(cm.exception.detail))

    def test_sensitivity_is_sticky_within_a_conversation(self):
        data = {"model": "auto-balanced", "messages": [{"role": "user", "content": f"key {KEY}"}]}
        asyncio.run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, "completion"))
        data2 = {"model": "auto-balanced", "messages": [{"role": "user", "content": f"key {KEY}"},
                                                         {"role": "assistant", "content": "ok"},
                                                         {"role": "user", "content": "now something harmless"}]}
        d = asyncio.run(h.proxy_handler_instance.async_pre_call_hook(None, None, data2, "completion"))
        self.assertTrue(d["metadata"]["auto_router"]["sensitive"])

    def test_pin_to_unsafe_model_is_ignored_when_safety_on(self):
        d = self.call("auto-balanced", "model:deepseek explain this")
        self.assertNotEqual(d["model"], "pool-deepseek")
        self.assertIn("not allowed", d["metadata"]["auto_router"]["pin_note"])

    def test_plain_request_is_not_sensitive_and_has_fallbacks_list(self):
        d = self.call("auto-balanced", "explain closures")
        meta = d["metadata"]["auto_router"]
        self.assertFalse(meta["sensitive"])
        self.assertIsInstance(meta["fallbacks"], list)
        self.assertEqual(d["fallbacks"], meta["fallbacks"])


if __name__ == "__main__":
    unittest.main()
