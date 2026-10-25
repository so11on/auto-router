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
        d = self.call("auto-balanced", "model:deepseek-free explain this")
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


class LogsStayClean(unittest.TestCase):
    """SEC-14: no message content, secret or personal data reaches router.jsonl / usage.jsonl."""
    SENTINEL = "ZXQ-SENTINEL-do-not-log-4711"

    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV}

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_sentinel_never_appears_in_logs_even_in_error_text(self):
        import asyncio
        import json
        for path in (h.EVENT_FILE, h.USAGE_FILE):
            if os.path.exists(path):
                os.remove(path)
        os.environ.update(SAFETY_MODE="on", SENSITIVE_GUARD="on", SENSITIVE_MASK_SECRETS="on")
        h._sticky.clear()

        async def fake(text, *a, **k):
            return {"task": "codegen", "complexity": 3}
        h._classify = fake
        key = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"
        data = {"model": "auto-balanced", "messages": [{"role": "user", "content": f"{self.SENTINEL} key {key}"}]}
        data = asyncio.run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, "completion"))
        kwargs = {"model": data["model"], "litellm_params": {"metadata": data["metadata"]},
                  "exception": f"provider echoed: {self.SENTINEL} {key}", "standard_logging_object": {"error_str": f"echo {key}"}}
        start = end = __import__("time").time()
        asyncio.run(h.proxy_handler_instance.async_log_failure_event(kwargs, None, start, end))
        asyncio.run(h.proxy_handler_instance.async_log_success_event(kwargs, None, start, end))
        text = ""
        for path in (h.EVENT_FILE, h.USAGE_FILE):
            if os.path.exists(path):
                text += open(path).read()
        self.assertGreater(len(text), 0)
        self.assertNotIn(key, text)
        self.assertNotIn("A1b2C3d4E5f6G7h8I9j0K1l2M3n4", text)
        for line in text.splitlines():
            json.loads(line)
        self.assertNotIn("content", text.replace("content_filter", ""), "no message bodies in the logs")


class MidTask(unittest.TestCase):
    """RT-06: the DLP runs on every request; a conversation that turns sensitive moves to an allowed model and stays sensitive."""

    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV + ("DEEPSEEK_API_KEY",)}
        os.environ.update(SAFETY_MODE="off", SENSITIVE_GUARD="on", SENSITIVE_MASK_SECRETS="on", DEEPSEEK_API_KEY="k")
        h._sticky.clear()
        h._last_model.clear()
        self.orig_conf = h._configured
        h._configured = lambda name: True

        async def fake(text, *a, **k):
            return {"task": "codegen", "complexity": 1}
        h._classify = fake

    def tearDown(self):
        h._configured = self.orig_conf
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def call(self, messages):
        data = {"model": "auto-balanced", "messages": messages}
        return asyncio.run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, "completion"))

    def test_conversation_turns_sensitive_in_a_tool_result(self):
        base = [{"role": "user", "content": "add a helper function to the utils module"}]
        d1 = self.call(base)
        self.assertEqual(d1["model"], "deepseek-flash")           # restricted: fine for an ordinary prompt
        key = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"
        step = base + [{"role": "assistant", "content": None, "tool_calls": [{"id": "1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
                       {"role": "tool", "tool_call_id": "1", "content": f"API_KEY={key}"}]
        d2 = self.call(step)
        self.assertNotEqual(d2["model"], "deepseek-flash")
        self.assertEqual(h.safety.privacy_of(d2["model"]), "trusted")
        self.assertTrue(d2["metadata"]["auto_router"]["sensitive"])
        self.assertNotIn(key, repr(d2))
        d3 = self.call(base + [{"role": "assistant", "content": "done"}, {"role": "user", "content": "now something harmless " + "x" * 300}])
        self.assertTrue(d3["metadata"]["auto_router"]["sensitive"], "sensitivity is sticky for the rest of the conversation")
        self.assertEqual(h.safety.privacy_of(d3["model"]), "trusted")

    def test_guard_off_means_no_restriction(self):
        os.environ.update(SENSITIVE_GUARD="off", SENSITIVE_MASK_SECRETS="off")
        key = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"
        d = self.call([{"role": "user", "content": f"add a helper, key {key}"}])
        self.assertEqual(d["model"], "deepseek-flash")
        self.assertFalse(d["metadata"]["auto_router"]["sensitive"])
