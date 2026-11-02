"""Anthropic Messages <-> OpenAI Chat translation used by the gateway (gateway/translate_openai.py)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "gateway"))
import translate_openai as tr  # noqa: E402


def _events(raw: bytes):
    out = []
    for block in raw.decode().split("\n\n"):
        lines = dict(l.split(": ", 1) for l in block.splitlines() if ": " in l)
        if "data" in lines:
            out.append(json.loads(lines["data"]))
    return out


class ToOpenAI(unittest.TestCase):
    def test_tool_loop_history(self):
        req = {"model": "claude-sonnet-5-5", "max_tokens": 1000, "stream": True,
               "system": [{"type": "text", "text": "attribution"}, {"type": "text", "text": "You are Claude Code."}],
               "tools": [{"name": "Read", "description": "read", "input_schema": {"$schema": "x", "type": "object",
                                                                                   "properties": {"path": {"type": ["string", "null"]}},
                                                                                   "additionalProperties": False}},
                         {"type": "web_search_20250305", "name": "web_search"}],
               "messages": [{"role": "user", "content": "fix it"},
                            {"role": "assistant", "content": [{"type": "thinking", "thinking": "..", "signature": "s"},
                                                              {"type": "text", "text": "reading"},
                                                              {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "a.py"}}]},
                            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "x=1"}]},
                                                         {"type": "text", "text": "go on"}]}]}
        out = tr.to_openai(req, "gemini-3.8-flash")
        roles = [m["role"] for m in out["messages"]]
        self.assertEqual(roles, ["system", "user", "assistant", "tool", "user"])
        self.assertEqual(out["messages"][0]["content"], "attribution\nYou are Claude Code.")
        call = out["messages"][2]["tool_calls"][0]
        self.assertEqual(json.loads(call["function"]["arguments"]), {"path": "a.py"})
        self.assertEqual(call["extra_content"]["google"]["thought_signature"], tr.SKIP_SIGNATURE)  # Claude's call: no signature
        self.assertEqual(out["messages"][3], {"role": "tool", "tool_call_id": "t1", "content": "x=1"})
        self.assertEqual(len(out["tools"]), 1)  # server tool dropped
        params = out["tools"][0]["function"]["parameters"]
        self.assertNotIn("$schema", params)
        self.assertNotIn("additionalProperties", params)
        self.assertEqual(params["properties"]["path"], {"type": "string", "nullable": True})
        self.assertTrue(out["stream"] and out["stream_options"]["include_usage"])

    def test_error_result_marked(self):
        req = {"messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "is_error": True, "content": "boom"}]}]}
        self.assertEqual(tr.to_openai(req, "m")["messages"][0]["content"], "ERROR: boom")

    def test_non_gemini_keeps_schema(self):
        req = {"messages": [{"role": "user", "content": "hi"}],
               "tools": [{"name": "T", "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}}]}
        params = tr.to_openai(req, "gpt", gemini=False)["tools"][0]["function"]["parameters"]
        self.assertIn("additionalProperties", params)


class Stream(unittest.TestCase):
    def test_text_then_tool_call(self):
        st = tr.StreamTranslator("claude-sonnet-5-5")
        raw = b""
        for chunk in [{"choices": [{"delta": {"content": "Vou ler"}}]},
                      {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "Read", "arguments": '{"path":'},
                                                              "extra_content": {"google": {"thought_signature": "SIG"}}}]}}]},
                      {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"a.py"}'}}]}, "finish_reason": "stop"}]},
                      {"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 7}}]:
            raw += st.feed(b"data: " + json.dumps(chunk).encode())
        raw += st.feed(b"data: [DONE]") + st.finish()
        ev = _events(raw)
        types = [e["type"] for e in ev]
        self.assertEqual(types, ["message_start", "content_block_start", "content_block_delta", "content_block_stop",
                                 "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
                                 "message_delta", "message_stop"])
        self.assertEqual(ev[0]["message"]["model"], "claude-sonnet-5-5")
        self.assertEqual(ev[4]["content_block"], {"type": "tool_use", "id": "call_1", "name": "Read", "input": {}})
        args = "".join(e["delta"]["partial_json"] for e in ev if e.get("delta", {}).get("type") == "input_json_delta")
        self.assertEqual(json.loads(args), {"path": "a.py"})
        self.assertEqual(ev[-2]["delta"]["stop_reason"], "tool_use")  # Gemini says "stop" even with a tool call
        self.assertEqual(ev[-2]["usage"]["output_tokens"], 7)
        # the signature comes back on the next turn
        back = tr.to_openai({"messages": [{"role": "assistant", "content": [{"type": "tool_use", "id": "call_1", "name": "Read", "input": {}}]}]}, "g")
        self.assertEqual(back["messages"][0]["tool_calls"][0]["extra_content"]["google"]["thought_signature"], "SIG")

    def test_empty_stream_is_well_formed(self):
        ev = _events(tr.StreamTranslator("m").finish())
        self.assertEqual([e["type"] for e in ev], ["message_start", "message_delta", "message_stop"])


class NonStream(unittest.TestCase):
    def test_tool_call_message(self):
        resp = {"choices": [{"finish_reason": "stop", "message": {"content": None, "tool_calls": [
            {"id": "c", "function": {"name": "Bash", "arguments": '{"command": "ls"}'}}]}}], "usage": {"prompt_tokens": 5, "completion_tokens": 2}}
        msg = tr.to_anthropic(resp, "claude-haiku-5-5")
        self.assertEqual(msg["stop_reason"], "tool_use")
        self.assertEqual(msg["content"], [{"type": "tool_use", "id": "c", "name": "Bash", "input": {"command": "ls"}}])
        self.assertEqual(msg["usage"], {"input_tokens": 5, "output_tokens": 2})


if __name__ == "__main__":
    unittest.main()
