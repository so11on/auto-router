"""Offline tests for litellm/router_hook.py (no network, LiteLLM stubbed).

Run: python3 -m unittest discover -s tests -v      (needs: pip install pyyaml)
"""
import asyncio
import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["ROUTING_FILE"] = os.path.join(ROOT, "litellm", "routing.yaml")
os.environ["CLAUDE_PRIMARY"] = "cli"
os.environ["FREE_POOL_ENABLED"] = "true"
for _k in ("GEMINI_API_KEY", "GEMINI_FREE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
    os.environ[_k] = "test-key"  # engine availability: a model with a missing key is skipped
os.environ["SAFETY_MODE"] = "off"  # legacy routing tests; safety-on behaviour lives in test_hook_safety.py
os.environ["SENSITIVE_GUARD"] = "off"
os.environ["SENSITIVE_MASK_SECRETS"] = "off"
import tempfile as _t0  # noqa: E402

_work = _t0.mkdtemp()  # never the real data/ of a running install: it holds live quota state and cooldowns
os.environ["EVENT_LOG"] = os.path.join(_work, "test-router.jsonl")
os.environ["USAGE_FILE"] = os.path.join(_work, "test-usage.jsonl")

# stub the two litellm modules the hook imports
litellm = types.ModuleType("litellm")
integrations = types.ModuleType("litellm.integrations")
custom_logger = types.ModuleType("litellm.integrations.custom_logger")
custom_logger.CustomLogger = type("CustomLogger", (), {})
proxy_pkg = types.ModuleType("litellm.proxy")
proxy_server = types.ModuleType("litellm.proxy.proxy_server")
proxy_server.llm_router = None
proxy_pkg.proxy_server = proxy_server
sys.modules.update({"litellm": litellm, "litellm.integrations": integrations,
                    "litellm.integrations.custom_logger": custom_logger,
                    "litellm.proxy": proxy_pkg, "litellm.proxy.proxy_server": proxy_server})
sys.path.insert(0, os.path.join(ROOT, "litellm"))
import json as _json  # noqa: E402
import tempfile as _tmp  # noqa: E402
import yaml as _yaml  # noqa: E402

# every pool model id counts as verified (what `ar.mjs omniroute` would have written to data/pool-members.json)
_data = _tmp.mkdtemp()
with open(os.path.join(ROOT, "litellm", "models.yaml")) as _f:
    _ids = [m["omni"] for m in _yaml.safe_load(_f)["models"].values() if m.get("omni")]
with open(os.path.join(_data, "pool-members.json"), "w") as _f:
    _json.dump({c: [{"id": i, "privacy": "no_retention"} for i in _ids] for c in ("free-fast", "free-coding")}, _f)
os.environ["AR_DATA_DIR"] = _data
import router_hook as h  # noqa: E402


class Delta:
    def __init__(self, content=None, tool_calls=None):
        self.content, self.tool_calls = content, tool_calls


class Choice:
    def __init__(self, delta, finish_reason=None):
        self.delta, self.finish_reason = delta, finish_reason


class Chunk:
    def __init__(self, content=None, tool_calls=None):
        self.choices = [Choice(Delta(content, tool_calls))]


async def agen(items, fail_with=None):
    for i in items:
        yield i
    if fail_with:
        raise fail_with


async def collect(gen):
    return [c async for c in gen]


def run(coro):
    return asyncio.run(coro)


class Hook(unittest.TestCase):
    def setUp(self):
        h._sticky.clear()
        h._last_model.clear()
        self.fixed = {"task": "codegen", "complexity": 3}

        async def fake(_text, *a, **k):
            return dict(self.fixed)
        h._classify = fake

    def call(self, model, text="do the thing", call_type="completion", extra=None):
        data = {"model": model, "messages": [{"role": "user", "content": text}], **(extra or {})}
        return run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, call_type))

    def test_real_models_untouched(self):
        self.assertEqual(self.call("gemini-pro")["model"], "gemini-pro")

    def test_free_never_uses_paid_models(self):
        for task in ("qa", "codegen", "debug", "architecture", "writing"):
            for c in (1, 3, 5):
                self.fixed.update(task=task, complexity=c)
                d = self.call("auto-free", text=f"t {task} {c}")
                for name in [d["model"]] + d["fallbacks"]:
                    self.assertFalse(h.registry.is_paid(name) or h.registry.spec(name).get("subscription"), name)

    def test_pool_used_when_enabled_and_gemini_free_when_not(self):
        self.fixed.update(task="codegen", complexity=3)
        self.assertEqual(self.call("auto-free")["model"], "pool-cf-glm")
        h.FREE_POOL_ENABLED = False
        h.safety.settings = lambda _o=h.safety.settings: {**_o(), "safety_mode": "off"}
        try:
            self.assertEqual(self.call("auto-free", text="other")["model"], "gemini-free-flash-lite")
        finally:
            h.FREE_POOL_ENABLED = True
            h.safety.settings = h.safety.settings.__defaults__[0]

    def test_smart_scales_model_and_effort(self):
        self.fixed.update(task="codegen", complexity=3)
        self.assertEqual(self.call("auto-smart", text="a")["model"], "claude-sonnet-cli")
        self.fixed.update(complexity=5, task="debug")
        d = self.call("auto-smart", text="b")
        self.assertEqual((d["model"], d["reasoning_effort"]), ("claude-opus-cli", "high"))

    def test_task_adjustment(self):
        self.fixed.update(task="architecture", complexity=4)
        self.assertEqual(self.call("auto-smart")["metadata"]["auto_router"]["complexity"], 5)
        self.fixed.update(task="qa", complexity=3)
        self.assertEqual(self.call("auto-smart", text="x")["metadata"]["auto_router"]["complexity"], 2)

    def test_tool_turn_reuses_decision(self):
        self.fixed["complexity"] = 5
        first = self.call("auto-smart", text="same conversation")
        self.fixed["complexity"] = 1
        data = {"model": "auto-smart", "messages": [
            {"role": "user", "content": "same conversation"}, {"role": "tool", "content": "ok"}]}
        again = run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, "completion"))
        self.assertEqual(again["model"], first["model"])

    def test_new_simpler_request_can_downgrade(self):
        self.fixed.update(task="debug", complexity=5)
        long_text = "conv " + "x" * 300
        self.assertEqual(self.call("auto-smart", text=long_text)["model"], "claude-opus-cli")
        self.fixed.update(task="qa", complexity=1)
        d = self.call("auto-smart", text=long_text)
        self.assertEqual(d["model"], "claude-haiku-api")  # a simpler, long new request goes down at once

    def test_a_short_message_does_not_drop_below_the_previous_band(self):
        self.fixed.update(task="debug", complexity=5)
        self.assertEqual(self.call("auto-smart", text="conv")["model"], "claude-opus-cli")
        self.fixed.update(task="qa", complexity=1)
        self.assertEqual(self.call("auto-smart", text="conv")["model"], "claude-opus-cli")

    def test_claude_primary_api(self):
        old = h.CLAUDE_PRIMARY
        h.CLAUDE_PRIMARY = "api"
        try:
            self.fixed.update(task="codegen", complexity=3)
            self.assertEqual(self.call("auto-smart")["model"], "claude-sonnet-api")
        finally:
            h.CLAUDE_PRIMARY = old

    def test_handoff_note_on_model_change(self):
        self.fixed.update(task="codegen", complexity=1)
        first = self.call("auto-balanced", text="conv2 " + "x" * 300)
        self.fixed.update(task="codegen", complexity=5)
        d = self.call("auto-balanced", text="conv2 " + "x" * 300)
        self.assertNotEqual(first["model"], d["model"])
        self.assertEqual(d["messages"][0]["role"], "system")
        self.assertIn("Handoff", d["messages"][0]["content"])

    def test_responses_api_effort(self):
        self.fixed.update(task="debug", complexity=5)
        data = {"model": "auto-smart", "input": "plan this"}
        d = run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, "responses"))
        self.assertEqual(d["reasoning"], {"effort": "high"})

    def test_route_event_is_logged(self):
        path = os.environ["EVENT_LOG"]
        if os.path.exists(path):
            os.remove(path)
        self.call("auto-smart")
        with open(path) as f:
            rows = [__import__("json").loads(line) for line in f]
        self.assertEqual(rows[-1]["type"], "route")
        self.assertEqual(rows[-1]["mode"], "smart")

    def test_heuristic_fallback(self):
        self.assertEqual(h._heuristic("fix this error")["task"], "debug")


class Pins(unittest.TestCase):
    def setUp(self):
        h._sticky.clear()
        h._last_model.clear()

        async def fake(_text, *a, **k):
            return {"task": "explain", "complexity": 1}
        h._classify = fake

    def call(self, model, text, extra_msgs=()):
        data = {"model": model, "messages": [{"role": "user", "content": text}, *extra_msgs]}
        return run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, "completion"))

    def test_bang_pin_selects_model_and_is_stripped(self):
        d = self.call("auto-smart", "!opus refactor the parser")
        self.assertEqual((d["model"], d["reasoning_effort"]), ("claude-opus-cli", "high"))
        self.assertEqual(d["messages"][0]["content"], "refactor the parser")
        self.assertEqual(d["metadata"]["auto_router"]["pinned"], "opus")

    def test_model_colon_pin(self):
        self.assertEqual(self.call("auto-balanced", "model:qwen explain this")["model"], "pool-qwen")

    def test_natural_phrases(self):
        self.assertEqual(self.call("auto-smart", "Faça a migração usando o Opus")["model"], "claude-opus-cli")
        self.assertEqual(self.call("auto-smart", "write tests, using sonnet please")["model"], "claude-sonnet-cli")

    def test_no_false_positive(self):
        d = self.call("auto-smart", "explain what Opus is in music")
        self.assertIsNone(d["metadata"]["auto_router"]["pinned"])

    def test_sec06_pin_token_must_start_a_line_or_follow_whitespace(self):
        for text in ("see foo!opus here", "open https://x.io/model:opus now", "path/!opus/file"):
            self.assertIsNone(self.call("auto-smart", text)["metadata"]["auto_router"]["pinned"], text)
        self.assertEqual(self.call("auto-smart", "do it\n!opus now")["metadata"]["auto_router"]["pinned"], "opus")
        self.assertEqual(self.call("auto-smart", "ok model:haiku")["metadata"]["auto_router"]["pinned"], "haiku")

    def test_sec06_natural_pin_only_in_a_short_sentence(self):
        long_sentence = "Please explain in great detail every single step of how the compiler front end works and how the whole optimisation pipeline is organised, using Opus"
        self.assertGreater(len(long_sentence), 120)
        self.assertIsNone(self.call("auto-smart", long_sentence)["metadata"]["auto_router"]["pinned"])
        self.assertEqual(self.call("auto-smart", "Refactor this file. Do it using Opus")["metadata"]["auto_router"]["pinned"], "opus")

    def test_ambiguous_names_need_bang(self):
        d = self.call("auto-smart", "use pro techniques to write this")
        self.assertIsNone(d["metadata"]["auto_router"]["pinned"])
        self.assertEqual(self.call("auto-smart", "!pro write this")["model"], "gemini-pro")

    def test_auto_free_ignores_paid_pin(self):
        d = self.call("auto-free", "!opus hello")
        meta = d["metadata"]["auto_router"]
        self.assertIsNone(meta["pinned"])
        self.assertIn("never uses paid", meta["pin_note"])
        self.assertFalse(h.registry.is_paid(d["model"]))
        self.assertNotIn("!opus", d["messages"][0]["content"])

    def test_auto_free_accepts_free_pin(self):
        self.assertEqual(self.call("auto-free", "!qwen hi")["model"], "pool-qwen")

    def test_tool_turn_stays_on_pinned_model(self):
        self.call("auto-smart", "!opus do it")
        d = self.call("auto-smart", "!opus do it", extra_msgs=[{"role": "tool", "content": "ok"}])
        self.assertEqual(d["model"], "claude-opus-cli")

    def test_copilot_user_request_tag_is_used(self):
        wrapped = "<context>the file mentions !haiku in a comment</context>\n<userRequest>\nplease !opus fix it\n</userRequest>"
        self.assertEqual(self.call("auto-smart", wrapped)["model"], "claude-opus-cli")

    def test_footer_warns_when_pinned_model_did_not_answer(self):
        req = {"metadata": {"auto_router": {"requested": "auto-smart", "model": "claude-opus-cli", "pinned": "opus", "t0": 0}},
               "model": "claude-opus-cli"}
        self.assertIn("pinned model unavailable", h._footer(req, "claude-code-sonnet", []))
        self.assertNotIn("unavailable", h._footer(req, "claude-code-opus", []))

    def test_footer_says_pinned(self):
        req = {"metadata": {"auto_router": {"requested": "auto-smart", "model": "claude-opus-cli", "pinned": "opus", "t0": 0}},
               "model": "claude-opus-cli"}
        self.assertIn("pinned: opus", h._footer(req, "x", []))


class OpenAI(unittest.TestCase):
    def setUp(self):
        h._sticky.clear()
        h._last_model.clear()

        async def fake(_text, *a, **k):
            return {"task": "codegen", "complexity": 3}
        h._classify = fake

    def call(self, text):
        data = {"model": "auto-smart", "messages": [{"role": "user", "content": text}]}
        return run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, "completion"))

    def test_gpt_names_get_the_openai_route_suffix(self):
        self.assertEqual(h._resolve("gpt-main"), "gpt-main-cli")
        old = h.OPENAI_PRIMARY
        h.OPENAI_PRIMARY = "api"
        try:
            self.assertEqual(h._resolve("gpt-max"), "gpt-max-api")
            self.assertEqual(h._resolve("gpt-max-cli"), "gpt-max-cli")  # explicit suffix is kept
        finally:
            h.OPENAI_PRIMARY = old

    def test_pin_to_gpt(self):
        d = self.call("!gpt do the thing")
        self.assertEqual((d["model"], d["reasoning_effort"]), ("gpt-main-cli", "medium"))
        self.assertEqual(self.call("!gpt-max big refactor")["model"], "gpt-max-cli")

    def test_pin_to_model_that_is_not_configured_is_ignored_with_a_note(self):
        old = h._configured
        h._configured = lambda name: not name.startswith("gpt-")
        try:
            d = self.call("!gpt do the thing")
        finally:
            h._configured = old
        meta = d["metadata"]["auto_router"]
        self.assertIsNone(meta["pinned"])
        self.assertIn("not available", meta["pin_note"])
        self.assertNotIn("!gpt", d["messages"][0]["content"])


class Footer(unittest.TestCase):
    ROUTE = {"metadata": {"auto_router": {"requested": "auto-free", "model": "free-pool-fast", "task": "explain",
                                          "complexity": 1, "effort": None, "t0": 0}}}

    def stream(self, items, req=None):
        req = {**self.ROUTE, "model": "free-pool-fast", "messages": [{"role": "user", "content": "x"}], **(req or {})}
        return h.proxy_handler_instance.async_post_call_streaming_iterator_hook(None, agen(items), req)

    def finish(self):
        c = Chunk("")
        c.choices[0].finish_reason = "stop"
        return c

    def test_footer_before_finish_chunk(self):
        out = run(collect(self.stream([Chunk("Hi"), self.finish()])))
        texts = [c.choices[0].delta.content for c in out]
        self.assertIn("auto-router · auto-free → free-pool-fast", "".join(t or "" for t in texts))
        self.assertEqual(out[-1].choices[0].finish_reason, "stop")        # finish chunk stays last
        self.assertIsNone(out[-2].choices[0].finish_reason)

    def test_no_footer_on_tool_call_turn(self):
        out = run(collect(self.stream([Chunk(None, tool_calls=[{"id": "1"}]), self.finish()])))
        self.assertNotIn("auto-router ·", "".join(c.choices[0].delta.content or "" for c in out))

    def test_no_footer_for_non_auto_requests(self):
        out = run(collect(self.stream([Chunk("Hi"), self.finish()], req={"metadata": {}})))
        self.assertNotIn("auto-router ·", "".join(c.choices[0].delta.content or "" for c in out))

    def test_footer_is_stripped_from_history(self):
        data = {"model": "auto-smart", "messages": [
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "answer\n\n---\n*auto-router · auto-smart → claude-haiku-cli · explain c1 · 2.0s*"},
            {"role": "user", "content": "follow up"}]}
        d = run(h.proxy_handler_instance.async_pre_call_hook(None, None, data, "completion"))
        self.assertEqual([m for m in d["messages"] if m["role"] == "assistant"][0]["content"], "answer")


class StreamContinuation(unittest.TestCase):
    def setUp(self):
        class Router:
            fallbacks = [{"m1": ["m2", "m3"]}]
            calls = []

            async def acompletion(inner, model, messages, stream, **kw):
                inner.calls.append((model, messages))
                return agen([Chunk("rest "), Chunk("of answer")])
        self.router = Router()
        proxy_server.llm_router = self.router

    def tearDown(self):
        proxy_server.llm_router = None

    def stream(self, items, error, request=None):
        req = request or {"model": "m1", "messages": [{"role": "user", "content": "go"}]}
        return h.proxy_handler_instance.async_post_call_streaming_iterator_hook(None, agen(items, error), req)

    def test_continues_on_next_model_with_notice(self):
        out = run(collect(self.stream([Chunk("Hello ")], RuntimeError("connection lost"))))
        text = "".join(c.choices[0].delta.content or "" for c in out)
        self.assertIn("Hello ", text)
        self.assertIn("interrupted", text)
        self.assertIn("m2", text)
        self.assertTrue(text.endswith("rest of answer"))
        model, messages = self.router.calls[0]
        self.assertEqual(model, "m2")
        self.assertEqual(messages[-2], {"role": "assistant", "content": "Hello "})

    def test_no_text_yet_reraises(self):
        with self.assertRaises(RuntimeError):
            run(collect(self.stream([], RuntimeError("boom"))))
        self.assertEqual(self.router.calls, [])

    def test_tool_calls_are_not_resumed(self):
        with self.assertRaises(RuntimeError):
            run(collect(self.stream([Chunk("x", tool_calls=[{"id": "1"}])], RuntimeError("boom"))))

    def test_no_fallback_left_reraises(self):
        self.router.fallbacks = []
        with self.assertRaises(RuntimeError):
            run(collect(self.stream([Chunk("Hello ")], RuntimeError("boom"))))

    def test_clean_stream_untouched(self):
        out = run(collect(self.stream([Chunk("a"), Chunk("b")], None)))
        self.assertEqual("".join(c.choices[0].delta.content for c in out), "ab")


if __name__ == "__main__":
    unittest.main()
