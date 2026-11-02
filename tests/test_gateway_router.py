"""Claude Code gateway: funding shadow prices and the `auto` decision (gateway/funding.py, gateway/router.py).

The rule under test (docs/GATEWAY.md): adequacy first; among adequate models the cheapest; funding balance only breaks ties
between equivalent adequate models; ask only when the adequate models are all out of quota."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "gateway"))
import funding  # noqa: E402
import router as rt  # noqa: E402

NOW = 1_800_000_000.0  # fixed clock (2027-01-15)
DAY = 86400.0


def snap(u5, u7, reset5=NOW + 3 * 3600, reset7=NOW + 3 * DAY, status="allowed"):
    return {"ts": NOW, "status": status, "windows": {"5h": {"utilization": u5, "reset": reset5},
                                                      "7d": {"utilization": u7, "reset": reset7}}}


def cfg():
    c = rt.load_config(local_path="/nonexistent")
    for m in ("gemini-flash-lite", "gemini-flash", "gemini-pro"):
        c["models"][m]["enabled"] = True
    c["funding"]["google"] = {"kind": "money", "currency": "USD", "lots": [{"remaining": 10, "ends": "2027-06-30"}],
                              "prepaid": {"amount": 8}, "allow_payg": False}
    return c


def analysis(task="qa", c=1, depth=None, unc=0.1, tools=1, risk=False, source="llm"):
    return {"task": task, "complexity": c, "reasoning_depth": depth or c, "uncertainty": unc, "tool_intensity": tools,
            "scope": "small", "risk": risk, "long_output": False, "source": source}


def classifier(*args, **kw):
    calls = []

    def f(text, checkpoint=False, sensitive=False):
        calls.append((text[:40], checkpoint, sensitive))
        return analysis(*args, **kw)
    f.calls = calls
    return f


def make(conf=None, cls=None, snapshot=None, spent=0.0):
    tmp = tempfile.mkdtemp()
    led = funding.Ledger(os.path.join(tmp, "spend.json"))
    if spent:
        led.data["spent"]["google"] = spent
    r = rt.Router(cfg=conf or cfg(), routing=rt.load_routing(), classify=cls or classifier(), ledger=led,
                  outcomes=rt.Outcomes(os.path.join(tmp, "outcomes.json")), env={"GEMINI_API_KEY": "x"}, clock=lambda: NOW,
                  settings={"safety_mode": "on", "sensitive_guard": "on", "sensitive_allowed": {"trusted"}, "images": "trusted_only",
                            "fail_mode": "closed", "mask_secrets": "on", "mask_pii": "off"})
    r.claude_snapshot = snapshot if snapshot is not None else snap(0.3, 0.45, reset5=NOW + 2 * 3600, reset7=NOW + 3.5 * DAY)
    return r


def req(text="oi", tools=True, model="claude-sonnet-5-5", messages=None, system="Primary working directory: /tmp/none-proj"):
    return {"model": model, "system": [{"type": "text", "text": system}], "max_tokens": 1000, "stream": True,
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}] if tools else [],
            "messages": messages or [{"role": "user", "content": [{"type": "text", "text": text}]}]}


def hdr(prompt="p1", rclass="main", sid="s1", agent=None):
    h = {"x-claude-code-request-class": rclass, "x-claude-code-session-id": sid, "x-claude-code-prompt-id": prompt}
    if agent:
        h["x-claude-code-agent-type"] = agent
    return h


def tool_step(base_msgs, ok=True, n=1, name="Read"):
    msgs = list(base_msgs)
    for _ in range(n):
        msgs.append({"role": "assistant", "content": [{"type": "tool_use", "id": f"t{len(msgs)}", "name": name, "input": {"i": len(msgs)}}]})
        msgs.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{len(msgs) - 1}",
                                                  "content": "ok" if ok else "Error: boom", "is_error": not ok}]})
    return msgs


STATES = {"room": snap(0.05, 0.15, reset5=NOW + 4 * 3600, reset7=NOW + 1 * DAY),
          "on pace": snap(0.3, 0.45, reset5=NOW + 2 * 3600, reset7=NOW + 3.5 * DAY),
          "tight week": snap(0.3, 0.85, reset5=NOW + 2 * 3600, reset7=NOW + 3 * DAY)}


class Funding(unittest.TestCase):
    def test_parse_unified(self):
        s = funding.parse_unified({"anthropic-ratelimit-unified-5h-utilization": "0.11", "anthropic-ratelimit-unified-5h-reset": "1793649000",
                                   "anthropic-ratelimit-unified-7d-utilization": "0.18", "Anthropic-Ratelimit-Unified-Status": "allowed"})
        self.assertEqual(s["windows"]["5h"]["utilization"], 0.11)
        self.assertEqual(s["status"], "allowed")

    def test_window_pace(self):
        room = funding.claude_state(snap(0.1, 0.2, reset7=NOW + 0.5 * DAY), NOW)
        self.assertLess(room["lambda"], 0.08)               # allowance that would be lost at the reset
        tight = funding.claude_state(snap(0.2, 0.9, reset7=NOW + 4 * DAY), NOW)
        self.assertGreater(tight["lambda"], 1.0)            # would run out before the reset

    def test_exhausted_window_and_reset(self):
        st = funding.claude_state(snap(1.0, 0.5), NOW)
        self.assertTrue(st["exhausted"])
        self.assertEqual(st["until"], NOW + 3 * 3600)
        self.assertFalse(funding.claude_state(snap(1.0, 0.5, reset5=NOW - 10), NOW)["exhausted"])

    def test_lot_cheap_only_near_its_end(self):
        src = {"lots": [{"remaining": 10, "ends": "2027-01-31"}], "prepaid": {"amount": 8}}
        now = funding._ts("2027-01-21")
        self.assertEqual(funding.credit_state(src, 0.0, 0.0, now)["lambda"], 0.0)   # 10 days left, nothing spends it
        self.assertAlmostEqual(funding.credit_state(src, 0.0, 0.5, now)["lambda"], 0.2, places=2)  # half would expire
        self.assertEqual(funding.credit_state(src, 0.0, 5.0, now)["lambda"], 0.4)
        self.assertEqual(funding.credit_state(src, 0.0, 0.0, funding._ts("2026-10-01"))["lambda"], 0.4)  # months ahead
        self.assertEqual(funding.credit_state(src, 12.0, 0.0, now)["kind"], "prepaid_balance")
        self.assertTrue(funding.credit_state(src, 18.5, 0.0, now)["exhausted"])     # payg not allowed
        self.assertEqual(funding.credit_state(dict(src, allow_payg=True), 18.5, 0.0, now)["kind"], "payg")

    def test_lots_oldest_first_and_currency(self):
        src = {"currency": "BRL", "lots": [{"remaining": 58, "ends": "2027-07-30"}, {"remaining": 29, "ends": "2027-01-31"}]}
        st = funding.credit_state(src, 4.0, 1.0, funding._ts("2026-12-01"), rates={"BRL": 5.8})
        self.assertAlmostEqual(st["lot_remaining_usd"], 1.0, places=3)
        with self.assertRaises(ValueError):
            funding.credit_state(src, 0, 0, NOW, rates={})


    def test_overage_is_not_used_unless_allowed(self):
        sn = dict(snap(1.0, 0.4, status="rejected"), overage="allowed")
        self.assertTrue(funding.claude_state(sn, NOW)["exhausted"])
        paying = funding.claude_state(sn, NOW, cfg={"allow_overage": True})
        self.assertFalse(paying["exhausted"])
        self.assertEqual(paying["lambda"], 1.0)


class Adequacy(unittest.TestCase):
    def test_trivial_question_gets_the_cheapest_adequate(self):
        d = make(cls=classifier("qa", 1)).decide(req("o que é uma closure?"), hdr())
        rows = d["candidates"]
        adequate = [r for r in rows if r[3] and r[4]]
        self.assertEqual(d["model"], min(adequate, key=lambda r: r[2])[0])
        self.assertNotEqual(d["model"], "claude-opus-cli")

    def test_hard_reasoning_needs_the_strong_model(self):
        d = make(cls=classifier("architecture", 5, depth=5)).decide(req("redesenhe a arquitetura de eventos"), hdr())
        self.assertEqual(d["model"], "claude-opus-cli")
        self.assertEqual(d["effort"], "high")

    def test_reasoning_depth_disqualifies_small_models(self):
        r = make()
        sess = r._session("x")
        need = {"tools": True, "ctx": 30000}
        shallow, _ = r.candidates(analysis("debug", 3, depth=2), 3.3, need, sess, "*")
        deep, _ = r.candidates(analysis("debug", 3, depth=5), 3.3, need, sess, "*")
        get = lambda rows, n: next(x for x in rows if x["name"] == n)  # noqa: E731
        self.assertGreater(get(shallow, "claude-haiku-cli")["adequacy"], get(deep, "claude-haiku-cli")["adequacy"])
        self.assertFalse(get(deep, "gemini-flash-lite")["adequate"])

    def test_agent_work_penalises_unreliable_tool_calls(self):
        r = make()
        sess = r._session("x")
        rows, _ = r.candidates(analysis("feature", 3, tools=3), 3.0, {"tools": True, "ctx": 20000}, sess, "*")
        pro = next(x for x in rows if x["name"] == "gemini-pro")
        self.assertIn("tools", pro["why"])                  # tools: 2 in models.yaml

    def test_uncertainty_and_project_raise_the_requirement(self):
        sure = make(cls=classifier("codegen", 3, unc=0.0)).decide(req("x"), hdr())
        unsure = make(cls=classifier("codegen", 3, unc=0.8)).decide(req("x"), hdr())
        self.assertGreater(unsure["required"], sure["required"])
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, ".auto-router"))
        with open(os.path.join(tmp, ".auto-router", "policy.yaml"), "w") as f:
            f.write("criticality: critical\n")
        crit = make(cls=classifier("codegen", 3, unc=0.0)).decide(req("x", system=f"Primary working directory: {tmp}"), hdr())
        self.assertEqual(crit["required"], sure["required"] + 1)

    def test_quota_state_does_not_change_a_clear_choice(self):
        """Adequacy decides, the plan balance does not: the same task gets the same model whatever the week looks like, unless
        two adequate models are equivalent (then the balance breaks the tie)."""
        for task, c, depth in (("qa", 1, 1), ("feature", 3, 3), ("debug", 4, 5), ("architecture", 5, 5)):
            picks = {name: make(cls=classifier(task, c, depth=depth), snapshot=s).decide(req("x"), hdr())
                     for name, s in STATES.items()}
            models = {d["model"] for d in picks.values()}
            if len(models) > 1:  # allowed only as a tie between equivalent adequate models
                d = picks["on pace"]
                rows = [r for r in d["candidates"] if r[0] in models]
                self.assertTrue(all(r[3] for r in rows), (task, rows))
                self.assertLessEqual(max(r[1] for r in rows) - min(r[1] for r in rows), 0.5, (task, rows))

    def test_tie_between_equivalent_models_goes_to_the_source_with_slack(self):
        r = make()
        rows = [{"name": "a", "adequacy": 4.0, "adequate": True, "usable": True, "cost": 0.010, "lambda": 0.9},
                {"name": "b", "adequacy": 3.8, "adequate": True, "usable": True, "cost": 0.012, "lambda": 0.1},
                {"name": "c", "adequacy": 5.0, "adequate": True, "usable": True, "cost": 0.050, "lambda": 0.0}]
        self.assertEqual(r.choose(rows)["name"], "b")       # a ~ b: the balance decides; c is not equivalent (5x the cost)
        rows[1]["adequacy"] = 3.2
        self.assertEqual(r.choose(rows)["name"], "a")       # no longer equivalent: the cheapest adequate wins

    def test_learned_history_lowers_a_model_that_keeps_failing(self):
        r = make()
        for _ in range(6):
            r.outcomes.record("*", "debug", "c3", "claude-sonnet-cli", False)
        sess = r._session("x")
        rows, _ = r.candidates(analysis("debug", 3), 3.0, {"tools": True, "ctx": 20000}, sess, "*")
        son = next(x for x in rows if x["name"] == "claude-sonnet-cli")
        self.assertEqual(son["why"]["history"], -1.0)

    def test_warm_cache_counts_in_cost(self):
        r = make()
        sess = r._session("x")
        need = {"tools": True, "ctx": 150000}
        cold, _ = r.candidates(analysis("codegen", 3), 3, need, sess, "*")
        sess["warm"]["claude-opus-cli"] = NOW
        warm, _ = r.candidates(analysis("codegen", 3), 3, need, sess, "*")
        opus = lambda rows: next(x for x in rows if x["name"] == "claude-opus-cli")["cost"]  # noqa: E731
        self.assertLess(opus(warm), opus(cold) / 5)


class Flow(unittest.TestCase):
    def test_picker_and_text_pins(self):
        r = make(cls=classifier("qa", 1))
        d = r.decide(req("oi", model="claude-opus-5-5"), hdr())
        self.assertEqual((d["model"], d["reason"], d["effort"]), ("claude-opus-cli", "picker pin", None))
        self.assertEqual(r.decide(req("!opus revise isto"), hdr("p2", sid="s2"))["model"], "claude-opus-cli")
        self.assertEqual(r.decide(req("foo!opus"), hdr("p3", sid="s3"))["reason"], "new prompt")

    def test_pins_never_bill_overage(self):
        out = dict(snap(1.0, 0.4, status="rejected"), overage="allowed")
        r = make(cls=classifier("qa", 1), snapshot=out)
        d = r.decide(req("oi", model="claude-opus-5-5"), hdr())
        self.assertNotEqual(d.get("source"), "claude")
        self.assertNotEqual(d.get("reason"), "picker pin")
        d2 = make(cls=classifier("qa", 1), snapshot=out).decide(req("!opus oi"), hdr("p9", sid="s9"))
        self.assertNotEqual(d2.get("model"), "claude-opus-cli")

    def test_auxiliary_and_explore(self):
        r = make()
        self.assertEqual(r.decide(req("t"), hdr(rclass="auxiliary"))["model"], "claude-haiku-cli")
        self.assertEqual(r.decide(req("t"), hdr(rclass="subagent", agent="Explore"))["model"], "claude-haiku-cli")

    def test_same_prompt_keeps_model_then_escalates_on_errors(self):
        r = make(cls=classifier("codegen", 2))
        base = req("crie um script").get("messages")
        d1 = r.decide(req(messages=base), hdr("p1"))
        d2 = r.decide(req(messages=tool_step(base)), hdr("p1"))
        self.assertEqual((d2["model"], d2["reason"]), (d1["model"], "same task"))
        d3 = r.decide(req(messages=tool_step(base, ok=False, n=2)), hdr("p1"))
        self.assertEqual(d3["required"], d1["required"] + 1)
        self.assertEqual(r.outcomes.data[f"*|codegen|c1-2|{d1['model']}"], [1, 1])  # the failure is learned

    def test_downgrade_needs_confirmations(self):
        r = make(cls=classifier("architecture", 5, depth=5))
        base = req("desenhe o sistema").get("messages")
        self.assertEqual(r.decide(req(messages=base), hdr("p1"))["model"], "claude-opus-cli")
        r.classify = classifier("mechanical", 1)
        msgs = tool_step(base, n=4)
        self.assertEqual(r.decide(req(messages=msgs), hdr("p1"))["model"], "claude-opus-cli")   # one vote: stay
        msgs = tool_step(msgs, n=4)
        d = r.decide(req(messages=msgs), hdr("p1"))                                               # confirmed: go down
        self.assertNotEqual(d["model"], "claude-opus-cli")
        self.assertEqual(d["reason"], "checkpoint: cheaper adequate")

    def test_success_is_recorded_when_the_next_prompt_starts(self):
        r = make(cls=classifier("qa", 1))
        d = r.decide(req("oi"), hdr("p1"))
        r.decide(req("e agora?"), hdr("p2"))
        self.assertEqual(r.outcomes.data[f"*|qa|c1-2|{d['model']}"], [1, 0])

    def test_claude_out_adequate_gemini_is_just_used(self):
        r = make(cls=classifier("data", 2), snapshot=snap(1.0, 0.6))
        d = r.decide(req("agrupe este csv", tools=False), hdr())
        self.assertEqual((d["action"], d["source"]), ("forward", "google"))

    def test_claude_out_and_only_claude_adequate_asks(self):
        r = make(cls=classifier("debug", 4, depth=5), snapshot=snap(1.0, 0.6))
        d = r.decide(req("ache a race condition"), hdr("p1"))
        self.assertEqual(d["action"], "answer")
        self.assertIn("Responda **1**", d["text"])
        msgs = req("x").get("messages") + [{"role": "assistant", "content": [{"type": "text", "text": d["text"]}]},
                                           {"role": "user", "content": [{"type": "text", "text": "1"}]}]
        d1 = r.decide(req(messages=msgs), hdr("p2"))
        self.assertEqual((d1["action"], d1["upstream"]), ("forward", "gemini"))
        self.assertEqual(d1["task"], "debug")
        d2 = r.decide(req(messages=tool_step(msgs)), hdr("p2"))        # keeps the chosen model while Claude is out
        self.assertEqual(d2["model"], d1["model"])

    def test_claude_out_offers_paid_extra_usage_only_when_configured(self):
        out = dict(snap(1.0, 0.6, status="rejected"), overage="allowed")
        d = make(cls=classifier("debug", 4, depth=5), snapshot=out).decide(req("x"), hdr("p1"))
        self.assertNotIn("**3**", d["text"])                    # default: never offered
        c = cfg()
        c["funding"]["claude"]["overage"] = "ask"
        r = make(conf=c, cls=classifier("debug", 4, depth=5), snapshot=out)
        d = r.decide(req("x"), hdr("p1"))
        self.assertIn("**3**", d["text"])
        msgs = req("x").get("messages") + [{"role": "assistant", "content": [{"type": "text", "text": d["text"]}]},
                                           {"role": "user", "content": [{"type": "text", "text": "3"}]}]
        d3 = r.decide(req(messages=msgs), hdr("p2"))
        self.assertEqual((d3["upstream"], d3["reason"]), ("anthropic", "chosen: Claude extra usage (paid, emergency)"))
        self.assertEqual(r.decide(req(messages=tool_step(msgs)), hdr("p2"))["model"], d3["model"])

    def test_claude_out_wait_queues_resume(self):
        r = make(cls=classifier("debug", 4, depth=5), snapshot=snap(1.0, 0.6))
        d = r.decide(req("x"), hdr("p1"))
        msgs = req("x").get("messages") + [{"role": "assistant", "content": [{"type": "text", "text": d["text"]}]},
                                           {"role": "user", "content": [{"type": "text", "text": "2"}]}]
        d2 = r.decide(req(messages=msgs, system="Primary working directory: /tmp/proj"), hdr("p2"))
        self.assertEqual(d2["reason"], "resume queued")
        self.assertEqual(r.resume_queue[0], {"session": "s1", "cwd": "/tmp/proj", "at": NOW + 3 * 3600 + 120, "queued": NOW})

    def test_nothing_else_allowed_never_pays_by_surprise(self):
        c = cfg()
        for m in ("gemini-flash-lite", "gemini-flash", "gemini-pro"):
            c["models"][m]["enabled"] = False
        self.assertEqual(make(conf=c, cls=classifier("qa", 1), snapshot=snap(1.0, 0.5)).decide(req("oi"), hdr())["action"], "answer")
        spent = make(cls=classifier("qa", 1), snapshot=snap(1.0, 0.5), spent=19.0)  # credits + prepayment used, payg off
        self.assertEqual(spent.decide(req("oi"), hdr())["action"], "answer")

    def test_sensitive_content_is_flagged(self):
        r = make(cls=classifier("qa", 1))
        r.decide(req("minha chave é sk-ant-api03-" + "a" * 40), hdr())
        self.assertTrue(r.sessions["s1"]["sensitive"])


if __name__ == "__main__":
    unittest.main()
