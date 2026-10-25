"""Offline tests for policy.py (mid-task switching), quota.py (forecast) and context.py (measure + compaction).

Run: python3 -m unittest discover -s tests -v      (needs: pip install pyyaml)
"""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "litellm"))
import context as ctxmod  # noqa: E402
import policy  # noqa: E402
import yaml  # noqa: E402
from quota import Tracker  # noqa: E402

CFG = dict(policy.DEFAULT_SWITCHING)


def tool_step(name="read_file", args='{"path": "a.py"}', result="ok"):
    return [{"role": "assistant", "content": None,
             "tool_calls": [{"id": "1", "type": "function", "function": {"name": name, "arguments": args}}]},
            {"role": "tool", "tool_call_id": "1", "content": result}]


def steps(n):
    return [tool_step(args=json.dumps({"path": f"f{i}.py"})) for i in range(n)]


def convo(*steps):
    msgs = [{"role": "user", "content": "do the task"}]
    for s in steps:
        msgs += s
    return msgs


class Policy(unittest.TestCase):
    """policy.py only decides WHEN a running task is re-evaluated; the choice itself is engine.route() (tests/test_engine.py)."""

    def test_failure_signals(self):
        sig = policy.signals(convo(tool_step(result="Error: tests failed"), tool_step(result="Traceback ...")))
        self.assertTrue(policy.failing(sig))
        self.assertTrue(policy.needs_checkpoint({}, sig, CFG))
        same = tool_step(name="grep", args='{"q": "x"}')
        loop = policy.signals(convo(same, same, same))
        self.assertTrue(loop["loop"] and policy.failing(loop))
        self.assertFalse(policy.failing(policy.signals(convo(*steps(2)))))

    def test_checkpoint_cadence(self):
        st = {"last_eval_step": 0}
        self.assertFalse(policy.needs_checkpoint(st, policy.signals(convo(*steps(3))), CFG))
        self.assertTrue(policy.needs_checkpoint(st, policy.signals(convo(*steps(4))), CFG))

    def test_downgrade_needs_confirmations_and_steps(self):
        st = {"steps_since_switch": 4}
        sig = policy.signals(convo(*steps(4)))
        self.assertFalse(policy.downgrade_allowed(st, sig, False, CFG))   # 1 of 2
        self.assertTrue(policy.downgrade_allowed(st, sig, False, CFG))    # 2 of 2
        self.assertEqual(st["down_votes"], 0)

    def test_no_downgrade_right_after_a_switch(self):
        st = {"steps_since_switch": 1, "down_votes": 5}
        self.assertFalse(policy.downgrade_allowed(st, policy.signals(convo(tool_step())), False, CFG))

    def test_new_user_turn_downgrades_immediately(self):
        st = {"down_votes": 1}
        self.assertTrue(policy.downgrade_allowed(st, policy.signals(convo()), True, CFG))
        self.assertEqual(st["down_votes"], 0)


class Quota(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.specs = {"m": {"quota": "counted", "limits": {"rpm": 10, "tpd": 1000}},
                      "c": {"quota": "claude-subscription"}, "n": {"quota": "none"}}
        self.t = Tracker(self.dir, lambda name: self.specs.get(name, {"quota": "counted", "limits": {}}))

    def test_counted_rpm_critical(self):
        now = time.time()
        for i in range(10):
            self.t.record_call("m", 1, True, now=now - i)
        self.assertEqual(self.t.status("m", now=now)["state"], "exhausted")

    def test_counted_tokens_warn_then_eta(self):
        now = time.time()
        self.t.record_call("m", 850, True, now=now - 1200)  # old usage, no current burn rate
        st = self.t.status("m", now=now)
        self.assertEqual((st["state"], st["window"]), ("warn", "tpd"))
        self.t.record_call("m", 50, True, now=now - 60)  # now burning ~5 tokens/min with 100 left -> ~20 min
        st = self.t.status("m", now=now)
        self.assertEqual(st["state"], "warn")
        self.assertAlmostEqual(st["eta_min"], 20, delta=1)

    def test_learned_cooldown_from_429(self):
        now = time.time()
        self.t.record_call("m", 0, False, "429: upstream error (reset after 30s)", now=now)
        st = self.t.status("m", now=now + 1)
        self.assertEqual(st["state"], "exhausted")
        self.assertEqual(self.t.status("m", now=now + 31)["state"], "ok")
        self.t.record_call("m", 0, False, "429 Daily token limit reached", now=now)
        self.assertGreater(self.t.status("m", now=now + 1)["resets_at"], now + 60)

    def test_claude_subscription_forecast(self):
        now = time.time()
        reset = now + 3 * 3600
        samples = [[now - 1800, 0.50, reset], [now - 900, 0.65, reset], [now, 0.80, reset]]
        json.dump({"status": "allowed", "windows": {"five_hour": {"utilization": 0.80, "resetsAt": reset}},
                   "samples": {"five_hour": samples}}, open(os.path.join(self.dir, "claude-quota.json"), "w"))
        st = self.t.status("c", now=now)
        self.assertEqual(st["window"], "five_hour")
        self.assertIn(st["state"], ("warn", "critical"))
        self.assertAlmostEqual(st["eta_min"], 20, delta=2)  # 0.20 left at 0.15/15 min

    def test_claude_rejected_and_unknown(self):
        self.assertEqual(self.t.status("c")["state"], "unknown")
        json.dump({"status": "rejected", "resetsAt": time.time() + 60}, open(os.path.join(self.dir, "claude-quota.json"), "w"))
        self.assertEqual(self.t.status("c")["state"], "exhausted")
        self.assertEqual(self.t.status("n")["state"], "unknown")


class Context(unittest.TestCase):
    def long_convo(self, turns=6):
        msgs = [{"role": "system", "content": "sys"}]
        for i in range(turns):
            msgs.append({"role": "user", "content": f"request {i} " + "x" * 2000})
            msgs += tool_step(result="y" * 9000)
            msgs.append({"role": "assistant", "content": f"done {i}"})
        return msgs

    def test_count_includes_tools(self):
        m = [{"role": "user", "content": "x" * 4000}]
        self.assertGreater(ctxmod.count_tokens(m, tools=[{"x": "y" * 4000}]), ctxmod.count_tokens(m))

    def test_compact_keeps_system_recent_turns_and_tool_pairs(self):
        msgs = self.long_convo()
        calls = []

        async def summarize(text, prev):
            calls.append(prev)
            return "SUMMARY"
        out, summary = asyncio.run(ctxmod.compact(msgs, "k1", summarize, keep_user_turns=2))
        self.assertEqual(summary, "SUMMARY")
        self.assertEqual(out[0]["content"], "sys")
        self.assertTrue(out[1]["content"].startswith(ctxmod.SUMMARY_PREFIX))
        users = [m for m in out if m["role"] == "user"]
        self.assertEqual([u["content"][:9] for u in users], ["request 4", "request 5"])
        for i, m in enumerate(out):  # every tool result still follows its assistant tool call
            if m["role"] == "tool":
                self.assertTrue(out[i - 1].get("tool_calls"))
        self.assertLess(ctxmod.count_tokens(out), ctxmod.count_tokens(msgs))

    def test_summary_is_incremental(self):
        msgs = self.long_convo(4)
        seen = []

        async def summarize(text, prev):
            seen.append(prev)
            return f"S{len(seen)}"
        asyncio.run(ctxmod.compact(msgs, "k2", summarize, 2))
        msgs += [{"role": "user", "content": "request 9"}, {"role": "assistant", "content": "ok"}]
        _, s = asyncio.run(ctxmod.compact(msgs, "k2", summarize, 2))
        self.assertEqual(seen, [None, "S1"])  # second call extends the first summary
        self.assertEqual(s, "S2")

    def test_touched_files(self):
        msgs = convo(tool_step(args='{"filePath": "/w/a.py"}'), tool_step(args='{"path": "b.ts"}'))
        self.assertEqual(ctxmod.touched_files(msgs), ["/w/a.py", "b.ts"])


if __name__ == "__main__":
    unittest.main()
