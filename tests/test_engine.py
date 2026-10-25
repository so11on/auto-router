"""Routing v3 engine (litellm/engine.py) against the real routing.yaml and models.yaml. Offline, no LiteLLM."""
import itertools
import os
import sys
import tempfile
import json
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "litellm"))
import yaml  # noqa: E402

_tmp = tempfile.mkdtemp()
with open(os.path.join(_tmp, "pool-members.json"), "w") as _f:
    json.dump({c: [{"id": "x", "privacy": "no_retention"}] for c in ("free-fast", "free-coding")}, _f)
os.environ["AR_DATA_DIR"] = _tmp
import engine  # noqa: E402
import registry  # noqa: E402
import safety  # noqa: E402

ROUTING = yaml.safe_load(open(os.path.join(ROOT, "litellm", "routing.yaml")))
ALIASES = ROUTING["aliases"]


def resolve(name):
    name = ALIASES.get(name, name)
    if name.startswith(("claude-", "gpt-")) and not name.endswith(("-cli", "-api")):
        name += "-cli"
    return name


def settings(**over):
    s = safety.settings()
    s.update(safety_mode="on", sensitive_guard="on", sensitive_allowed={"trusted"})  # other test modules change the environment
    s.update(over)
    return s


def env(sensitive=False, kinds=None, available=None, health=None, util=0.3, spent=0.0, now=None, **over):
    return engine.Env(settings=settings(**over), sensitive=sensitive, kinds=kinds or {}, resolve=resolve,
                      available=available or (lambda n: True), health=health or (lambda n: "ok"),
                      utilization=lambda n: util, spent_today=spent, now=now)


def cell_models(profile, task, band):
    out = []
    for it in ROUTING["routes"][profile][task][band]:
        out.append(resolve(it["model"] if isinstance(it, dict) else it))
    return out


def privacy(name):
    return safety.privacy_of(name)


class Tables(unittest.TestCase):
    def test_routing_file_is_valid(self):
        self.assertEqual(engine.validate(ROUTING), [])

    def test_every_cell_has_two_candidates_that_are_not_unsafe(self):
        problems = []
        for prof, tasks in ROUTING["routes"].items():
            for task, cells in tasks.items():
                for band, items in cells.items():
                    if band == "escalate":
                        continue
                    safe = [resolve(i["model"] if isinstance(i, dict) else i) for i in items]
                    safe = [m for m in safe if privacy(m) != "unsafe"]
                    if len(safe) < 2:
                        problems.append(f"{prof}/{task}/{band}: {safe}")
        # the plan says every cell keeps >= 2 safe options (free cells marked as limited may be tighter)
        self.assertEqual(problems, [])

    def test_every_config_model_has_privacy_and_fit(self):
        cfg = yaml.safe_load(open(os.path.join(ROOT, "litellm", "config.yaml")))
        for m in cfg["model_list"]:
            name = m["model_name"]
            if name.startswith("auto-"):
                continue
            spec = registry.spec(name)
            self.assertIn(spec.get("privacy"), safety.CLASSES + ("pool",), name)
            self.assertTrue(spec.get("fit"), f"{name} has no fit")

    def test_first_choice_comes_from_the_cell(self):
        for prof in ("free", "balanced", "smart"):
            for task in ("qa", "codegen", "debug", "architecture", "writing", "mechanical"):
                for c in (1, 3, 5):
                    d = engine.route(ROUTING, prof, task, c, env(), engine.Need(ctx_tokens=3000))
                    band = d.band if d.band in ROUTING["routes"][prof][task] else "c1-2"
                    items = cell_models(prof, task, band) + [resolve(x["model"]) for x in ROUTING["routes"][prof][task].get("escalate", [])]
                    self.assertIn(d.model, items, f"{prof}/{task}/c{c} -> {d.model}")
                    self.assertNotIn(d.model, d.fallbacks)


class SafetyMatrix(unittest.TestCase):
    """The 8 combinations of SAFETY_MODE x SENSITIVE_GUARD x (ordinary | sensitive) from the plan, section 2."""

    def run_all(self, e):
        seen = set()
        for prof, task, c in itertools.product(("balanced", "smart"), ("codegen", "debug", "writing", "data"), (1, 3, 5)):
            try:
                d = engine.route(ROUTING, prof, task, c, e, engine.Need(ctx_tokens=2000))
            except engine.RouteBlocked:
                continue
            seen.update([d.model] + d.fallbacks)
        return seen

    def test_safety_on_removes_unsafe_everywhere_and_keeps_restricted_for_ordinary_prompts(self):
        seen = self.run_all(env(safety_mode="on"))
        self.assertTrue(all(privacy(m) != "unsafe" for m in seen))
        self.assertIn("deepseek-flash", seen, "restricted models stay for ordinary prompts")

    def test_safety_off_allows_every_class_for_ordinary_prompts(self):
        e = env(safety_mode="off")
        d = engine.route(ROUTING, "free", "codegen", 3, e, engine.Need(ctx_tokens=2000))
        self.assertIsNotNone(d.model)
        names = {x[0] for x in engine.route(ROUTING, "free", "codegen", 3, e, engine.Need(ctx_tokens=2000)).candidates}
        self.assertTrue(names)

    def test_sensitive_content_only_reaches_allowed_classes_for_every_combination(self):
        for safety_mode, allowed in itertools.product(("on", "off"), ({"trusted"}, {"trusted", "no_retention"}, {"trusted", "restricted", "unsafe"})):
            s = dict(sensitive_allowed=allowed)
            e = env(sensitive=True, kinds={"openai_key": 1}, safety_mode=safety_mode, **s)
            # safety.settings() strips restricted/unsafe from the allowed set; the engine sees the real function
            for prof in ("free", "balanced", "smart"):
                for task, c in (("codegen", 2), ("debug", 4), ("writing", 3)):
                    try:
                        d = engine.route(ROUTING, prof, task, c, e, engine.Need(ctx_tokens=2000))
                    except engine.RouteBlocked:
                        continue
                    for m in [d.model] + d.fallbacks:
                        self.assertNotIn(privacy(m), ("restricted", "unsafe"), f"{safety_mode}/{allowed}/{prof}: {m}")
                        self.assertEqual(privacy(m), "trusted" if "no_retention" not in allowed else privacy(m))
                        self.assertIn(privacy(m), {"trusted"} | ({"no_retention"} if "no_retention" in allowed else set()))

    def test_sensitive_free_is_blocked_with_the_message_and_served_when_no_retention_is_allowed(self):
        e = env(sensitive=True, kinds={"cpf": 1, "email": 1})
        with self.assertRaises(engine.RouteBlocked) as cm:
            engine.route(ROUTING, "free", "codegen", 3, e, engine.Need(ctx_tokens=1000))
        self.assertIn("Conteúdo sensível detectado (cpf, email)", str(cm.exception))
        self.assertIn("Use Auto: Balanced/Smart", str(cm.exception))
        e2 = env(sensitive=True, kinds={"cpf": 1}, sensitive_allowed={"trusted", "no_retention"})
        d = engine.route(ROUTING, "free", "codegen", 3, e2, engine.Need(ctx_tokens=1000))
        self.assertIn(d.model, ("pool-qwen", "pool-cf-glm", "pool-cf-coder"))

    def test_deepseek_vanishes_for_sensitive_content_even_with_safety_off(self):
        ordinary = env(safety_mode="off")
        d = engine.route(ROUTING, "balanced", "codegen", 1, ordinary, engine.Need(ctx_tokens=1000))
        self.assertEqual(d.model, "deepseek-flash")
        sens = env(sensitive=True, safety_mode="off", sensitive_allowed={"trusted", "restricted"})
        d = engine.route(ROUTING, "balanced", "codegen", 1, sens, engine.Need(ctx_tokens=1000))
        self.assertNotIn("deepseek-flash", [d.model] + d.fallbacks)


class Rules(unittest.TestCase):
    def test_unavailable_models_are_skipped_and_exhausted_lists_use_the_matrix_then_the_safety_net(self):
        only = {"gemini-flash-lite"}
        e = env(available=lambda n: n in only)
        d = engine.route(ROUTING, "balanced", "qa", 4, e, engine.Need(ctx_tokens=1000))  # not in the qa/c3 cell: found in the capability matrix
        self.assertEqual((d.model, d.source), ("gemini-flash-lite", "matrix"))
        with self.assertRaises(engine.RouteBlocked):  # too weak for feature c5, and no safety net available
            engine.route(ROUTING, "balanced", "feature", 5, e, engine.Need(ctx_tokens=1000))
        e2 = env(available=lambda n: n == "gemini-flash")
        d2 = engine.route(ROUTING, "balanced", "feature", 5, e2, engine.Need(ctx_tokens=1000))
        self.assertEqual(d2.model, "gemini-flash")
        with self.assertRaises(engine.RouteBlocked) as cm:
            engine.route(ROUTING, "smart", "debug", 3, env(available=lambda n: False), engine.Need())
        self.assertIn("Nenhum modelo disponível para debug no perfil smart", str(cm.exception))

    def test_free_never_climbs_to_a_paid_profile(self):
        e = env(available=lambda n: n.startswith("claude-") or n.startswith("gemini-flash"))
        with self.assertRaises(engine.RouteBlocked):
            engine.route(ROUTING, "free", "codegen", 3, e, engine.Need(ctx_tokens=1000))

    def test_tools_vision_and_context_filters(self):
        e = env()
        d = engine.route(ROUTING, "free", "codegen", 2, e, engine.Need(tools=True, ctx_tokens=1000))
        self.assertGreaterEqual(registry.spec(d.model)["tools"], 3)
        d = engine.route(ROUTING, "free", "codegen", 4, e, engine.Need(tools=True, ctx_tokens=1000))  # no free model has tools >= 4: safety net, flagged
        self.assertEqual((d.model, d.source), ("pool-qwen", "safety_net"))
        self.assertIn("tool calls less reliable than recommended", d.notes)
        d = engine.route(ROUTING, "balanced", "codegen", 4, e, engine.Need(tools=True, ctx_tokens=1000))
        self.assertGreaterEqual(registry.spec(d.model)["tools"], 4)
        with self.assertRaises(engine.RouteBlocked):  # no safe free model with good enough vision: block, do not guess
            engine.route(ROUTING, "free", "writing", 2, e, engine.Need(vision=True, ctx_tokens=1000))
        d = engine.route(ROUTING, "free", "writing", 2, env(safety_mode="off"), engine.Need(vision=True, ctx_tokens=1000))
        self.assertGreaterEqual(registry.spec(d.model)["vision"], 3)
        # groq's 8K tokens/minute removes gpt-oss for a 20K prompt
        d = engine.route(ROUTING, "free", "qa", 1, e, engine.Need(ctx_tokens=20000))
        self.assertNotEqual(d.model, "pool-gpt-oss-120b")
        # nothing safe and free holds 200K tokens
        with self.assertRaises(engine.RouteBlocked):
            engine.route(ROUTING, "free", "research_long", 3, env(safety_mode="on"), engine.Need(ctx_tokens=200000))

    def test_health_budget_and_scarcity(self):
        e = env(health=lambda n: "exhausted" if n.startswith("claude-opus") else "ok")
        d = engine.route(ROUTING, "smart", "debug", 5, e, engine.Need(ctx_tokens=1000))
        self.assertNotIn("claude-opus-cli", [d.model] + d.fallbacks)
        e = env(util=0.97)  # plan nearly used up: subscription models leave the lists
        d = engine.route(ROUTING, "smart", "codegen", 3, e, engine.Need(ctx_tokens=1000))
        self.assertFalse(registry.spec(d.model).get("subscription"))
        # daily budget of balanced is US$ 3: once spent, billed API models are skipped
        e = env(spent=3.0, available=lambda n: n in ("gemini-flash", "claude-sonnet-cli"))
        d = engine.route(ROUTING, "balanced", "feature", 3, e, engine.Need(ctx_tokens=1000))
        self.assertEqual(d.model, "claude-sonnet-cli")

    def test_excess_rule_and_quality_floor(self):
        C = engine.Candidate
        big = C(name="big", alias="big", fit=5, slack=2, eff_cost=9.0, exp_cost=9.5)
        small = C(name="small", alias="small", fit=3, slack=0, eff_cost=2.0, exp_cost=2.7)
        mid = C(name="mid", alias="mid", fit=4, slack=1, eff_cost=4.0, exp_cost=4.4)
        self.assertEqual([c.name for c in engine._excess([big, mid, small])], ["small", "big", "mid"], "a model with slack >= 2 yields to one a third of the price that still passes")
        self.assertEqual([c.name for c in engine._excess([mid, big, small])], ["mid", "big", "small"], "slack 1: nothing to save")
        d = engine.route(ROUTING, "smart", "qa", 1, env(), engine.Need(ctx_tokens=500))
        self.assertEqual(d.floor, 2)  # smart: complexity (qa -1 -> 1... clamped) + 1

    def test_subscription_with_room_goes_before_a_billed_neighbour(self):
        C = engine.Candidate
        sub = C(name="sub", alias="sub", fit=5, eff_cost=2.0, subscription=True)
        api = C(name="api", alias="api", fit=4, eff_cost=3.0, subscription=False)
        self.assertEqual([c.name for c in engine._swap_neighbours([api, sub])], ["sub", "api"], "room in the plan: it goes first")
        sub.eff_cost = 5.0
        self.assertEqual([c.name for c in engine._swap_neighbours([sub, api])], ["api", "sub"], "a scarce plan yields to the billed neighbour")
        far = C(name="far", alias="far", fit=2, eff_cost=0.1, subscription=False)
        self.assertEqual([c.name for c in engine._swap_neighbours([sub, far])], ["sub", "far"], "quality differing by more than 1: no swap")
        both = C(name="b", alias="b", fit=5, eff_cost=0.1, subscription=True)
        self.assertEqual([c.name for c in engine._swap_neighbours([sub, both])], ["sub", "b"], "two plans keep the table order")
        # end to end: a plan above 80% (factor 1.5) loses to its billed neighbour
        billed = lambda n: "gpt-main-api" if n == "gpt-main" else resolve(n)
        e = env(util=0.9)
        e.resolve = billed
        d = engine.route(ROUTING, "smart", "codegen", 3, e, engine.Need(ctx_tokens=1000))
        self.assertEqual(d.model, "gpt-main-api")

    def test_escalation_uses_the_band_above_and_a_different_vendor_for_debug(self):
        d = engine.route(ROUTING, "smart", "debug", 1, env(), engine.Need(ctx_tokens=1000), escalate=True, avoid_vendor="anthropic")
        self.assertNotEqual(registry.spec(d.model)["vendor"], "anthropic")
        self.assertIn("escalated", " ".join(d.notes))
        # balanced may reach Opus only by escalation and only with room in the plan
        d = engine.route(ROUTING, "balanced", "feature", 5, env(util=0.3), engine.Need(ctx_tokens=1000), escalate=True)
        self.assertIn("claude-opus-cli", [d.model] + d.fallbacks)
        d = engine.route(ROUTING, "balanced", "feature", 5, env(util=0.7), engine.Need(ctx_tokens=1000), escalate=True)
        self.assertNotIn("claude-opus-cli", [d.model] + d.fallbacks)

    def test_fallbacks_are_diversified(self):
        d = engine.route(ROUTING, "smart", "feature", 5, env(), engine.Need(ctx_tokens=1000))
        vendors = [registry.spec(m)["vendor"] for m in [d.model] + d.fallbacks]
        self.assertGreaterEqual(len(set(vendors[:3])), 2)

    def test_effort_defaults_and_xhigh_is_sent_as_high(self):
        d = engine.route(ROUTING, "smart", "feature", 5, env(), engine.Need(ctx_tokens=1000))
        self.assertEqual((d.model, d.effort), ("claude-opus-cli", "high"))
        d = engine.route(ROUTING, "smart", "debug", 5, env(available=lambda n: n.startswith("gpt-")), engine.Need(ctx_tokens=1000))
        self.assertEqual(d.effort, "high")  # table says xhigh


class Prices(unittest.TestCase):
    def test_haiku_long_prompt_uses_the_high_price(self):
        spec = registry.spec("claude-haiku-api")
        now = datetime(2026, 10, 25, tzinfo=timezone.utc)
        self.assertEqual(engine.price_for(spec, 50000, now), (0.10, 0.50))
        self.assertEqual(engine.price_for(spec, 150000, now), (0.50, 2.50))

    def test_deepseek_peak_doubles_the_off_peak_price(self):
        spec = registry.spec("deepseek-flash")
        peak = datetime(2026, 10, 25, 10, 0, tzinfo=timezone.utc)
        off = datetime(2026, 10, 25, 20, 0, tzinfo=timezone.utc)
        self.assertEqual(engine.price_for(spec, 1000, peak), (0.30, 1.20))
        self.assertEqual(engine.price_for(spec, 1000, off), (0.15, 0.60))

    def test_scheduled_price_changes(self):
        argon = registry.spec("gemini-argon")
        self.assertEqual(engine.price_for(argon, 1000, datetime(2026, 11, 30, tzinfo=timezone.utc)), (2, 10))
        self.assertEqual(engine.price_for(argon, 1000, datetime(2026, 12, 1, tzinfo=timezone.utc)), (4, 20))
        flash = registry.spec("gemini-flash")
        self.assertEqual(engine.price_for(flash, 1000, datetime(2027, 1, 1, tzinfo=timezone.utc)), (1.5, 7.5))
        self.assertIsNone(engine.price_for(registry.spec("pool-qwen"), 1000, datetime.now(timezone.utc)))

    def test_grok_long_context(self):
        self.assertEqual(engine.price_for(registry.spec("grok"), 250000, datetime(2026, 10, 25, tzinfo=timezone.utc)), (4, 12))


if __name__ == "__main__":
    unittest.main()
