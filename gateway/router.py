"""`auto` for Claude Code: which model answers each request, with which effort (docs/GATEWAY.md, docs/PLAN-v0.6.md).

The rule, in this order (decided with the owner, 2026-11-02):
  1. ADEQUACY FIRST. The task analysis says what the task requires (complexity, reasoning depth, uncertainty, risk, project
     criticality, failures so far). Each model gets a continuous adequacy score for THIS task: its fit for the task type, minus a
     penalty for missing reasoning depth, for unreliable tool calls in agent work and for a context near its window, corrected by the
     success it actually had on this kind of task (outcome history). Adequate = score >= requirement.
  2. Among the adequate models, the CHEAPEST for this request (expected tokens x list price, prompt cache included). If the cheap
     ones are adequate they answer; if only an expensive one is, it answers. Never a bigger model "because there is room".
  3. Plan/credit balance (funding.py) only BREAKS TIES between adequate models of equivalent quality and cost, so no quota runs
     out early and no credit expires unused. It never swaps an adequate model for a less adequate one.
  4. No adequate model available because the Claude plan is out: ask (best available now, or wait and resume).

Inside one user prompt (x-claude-code-prompt-id) the model is kept; at checkpoints (every N tool steps, or at once on failure
signals) the remaining work is re-analysed: up at once when the current model is no longer adequate, down only with confirmations
(litellm/policy.py) and only when the cheaper model stays cheaper after paying its cold prompt cache.
"""
import copy
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "litellm"))

import yaml  # noqa: E402

import classify_rules  # noqa: E402
import dlp  # noqa: E402
import engine  # noqa: E402
import policy  # noqa: E402
import registry  # noqa: E402
import safety  # noqa: E402

import funding  # noqa: E402

LOCAL_CONFIG = os.environ.get("AR_GATEWAY_CONFIG", os.path.join(ROOT, "config", "local", "gateway.yaml"))
ROUTING_FILE = os.environ.get("AR_ROUTING_FILE", os.path.join(ROOT, "litellm", "routing.yaml"))
STATE_TTL = 6 * 3600
EFFORTS = ("low", "medium", "high")
TEXT_PINS = {"opus": "claude-opus-cli", "sonnet": "claude-sonnet-cli", "haiku": "claude-haiku-cli", "gemini": "gemini-argon",
             "argon": "gemini-argon", "pro": "gemini-pro", "flash": "gemini-flash", "lite": "gemini-flash-lite"}
PIN_RE = re.compile(r"(?:^|\s)!(opus|sonnet|haiku|gemini|argon|pro|flash|lite|esperar|wait)\b", re.I)
CWD_RE = re.compile(r"(?:Primary working directory|Working directory|cwd):\s*(/[^\n<]+)")
OUT_TOKENS = engine.OUTPUT_TOKENS


# ------------------------------------------------------------------ configuration
def _merge(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        out = dict(a)
        for k, v in b.items():
            out[k] = _merge(a.get(k), v) if k in a else v
        return out
    return b if b is not None else a


def load_config(local_path: str = None) -> dict:
    with open(os.path.join(HERE, "defaults.yaml")) as f:
        cfg = yaml.safe_load(f) or {}
    path = local_path or LOCAL_CONFIG
    if path and os.path.exists(path):
        with open(path) as f:
            cfg = _merge(cfg, yaml.safe_load(f) or {})
    return cfg


def load_routing() -> dict:
    try:
        with open(ROUTING_FILE) as f:
            return yaml.safe_load(f) or {}
    except OSError:
        return {}


# ------------------------------------------------------------------ request facts
def _blocks(content):
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b for b in content or [] if isinstance(b, dict)]


def user_text(msg: dict) -> str:
    """What the person typed in a user turn: text blocks without Claude Code's <system-reminder> injections."""
    parts = []
    for b in _blocks(msg.get("content")):
        if b.get("type") == "text":
            t = re.sub(r"<system-reminder>.*?</system-reminder>", "", b.get("text", ""), flags=re.S).strip()
            if t:
                parts.append(t)
    return "\n".join(parts)


def last_prompt(messages: list) -> str:
    for m in reversed(messages or []):
        if m.get("role") == "user" and not policy._is_tool_result_turn(m):
            return user_text(m)
    return ""


def first_prompt(messages: list) -> str:
    for m in messages or []:
        if m.get("role") == "user":
            return user_text(m)
    return ""


def has_image(messages: list) -> bool:
    return any(b.get("type") == "image" for m in messages or [] for b in _blocks(m.get("content")))


def est_tokens(req: dict) -> int:
    """~4 characters per token over everything the model will read (system, tools, messages)."""
    n = len(json.dumps(req.get("system") or "", ensure_ascii=False)) + len(json.dumps(req.get("tools") or [], ensure_ascii=False))
    n += len(json.dumps(req.get("messages") or [], ensure_ascii=False))
    return n // 4


def working_dir(req: dict):
    sysp = req.get("system")
    text = sysp if isinstance(sysp, str) else "\n".join(b.get("text", "") for b in sysp or [] if isinstance(b, dict))
    m = CWD_RE.search(text)
    return m.group(1).strip() if m else None


def project_policy(cwd) -> dict:
    """Optional <project>/.auto-router/policy.yaml: {criticality: draft|normal|critical, confidential: bool}."""
    if not cwd:
        return {}
    try:
        with open(os.path.join(cwd, ".auto-router", "policy.yaml")) as f:
            return yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
        return {}


def project_card(cwd, limit: int = 1200) -> str:
    """<project>/.auto-router/project.md, given to the classifier so it rates the task against the project (PLAN 2C)."""
    if not cwd:
        return ""
    try:
        with open(os.path.join(cwd, ".auto-router", "project.md")) as f:
            return f.read(limit)
    except OSError:
        return ""


def project_key(cwd) -> str:
    return hashlib.sha256((cwd or "").encode()).hexdigest()[:12] if cwd else "*"


# ------------------------------------------------------------------ outcome history (learned adequacy correction)
class Outcomes:
    """Per (project, task, band, model): how often the model finished a prompt without having to be escalated away.
    Feeds adequacy: a model that keeps failing a kind of task here loses up to 1 point; a reliable one gains a little."""

    def __init__(self, path: str):
        self.path = path
        self.data = {}
        try:
            with open(path) as f:
                self.data = json.load(f)
        except (OSError, ValueError, TypeError):
            pass

    @staticmethod
    def _keys(proj, task, band, model):
        return [f"{proj}|{task}|{band}|{model}", f"*|{task}|{band}|{model}"]

    def record(self, proj, task, band, model, ok: bool):
        for k in self._keys(proj, task, band, model):
            n, fails = self.data.get(k, [0, 0])
            self.data[k] = [n + 1, fails + (0 if ok else 1)]
        self.save()

    def adjustment(self, proj, task, band, model, min_n: int = 5) -> float:
        for k in self._keys(proj, task, band, model):
            n, fails = self.data.get(k, [0, 0])
            if n >= min_n:
                return max(-1.0, min(0.25, -(fails / n - 0.15) * 3))
        return 0.0

    def save(self):
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f)
        os.replace(tmp, self.path)


# ------------------------------------------------------------------ the router
class Router:
    def __init__(self, cfg: dict = None, routing: dict = None, classify=None, ledger=None, outcomes=None, env: dict = None,
                 clock=time.time, settings: dict = None):
        self.cfg = cfg or load_config()
        self.routing = routing if routing is not None else load_routing()
        self.classify = classify or (lambda text, checkpoint=False, sensitive=False: classify_rules.heuristic_rich(text))
        self.ledger = ledger or funding.Ledger(os.path.join(ROOT, "data", "gateway-spend.json"))
        self.outcomes = outcomes or Outcomes(os.path.join(ROOT, "data", "gateway-outcomes.json"))
        self.env = env if env is not None else os.environ
        self.clock = clock
        self.settings = settings or safety.settings()
        self.sessions = {}
        self.claude_snapshot = {}
        self.resume_queue = []

    # ---------- state
    def _session(self, key: str) -> dict:
        now = self.clock()
        for k in [k for k, v in self.sessions.items() if now - v["ts"] > STATE_TTL]:
            self.sessions.pop(k)
        s = self.sessions.setdefault(key, {"warm": {}, "sensitive": False, "kinds": {}})
        s["ts"] = now
        return s

    def note_plan(self, headers: dict):
        """Called by the server with every Anthropic response's headers."""
        snap = funding.parse_unified(headers, self.clock())
        if snap["windows"] or snap.get("status"):
            self.claude_snapshot = snap

    def mark_claude_limited(self, headers: dict):
        snap = funding.parse_unified(headers, self.clock())
        snap["status"] = "rejected"
        self.claude_snapshot = snap

    # ---------- funding (tie-break only)
    def source_state(self, source: str) -> dict:
        f = self.cfg.get("funding") or {}
        base = f.get("base") or {}
        if source == "claude":
            return funding.claude_state(self.claude_snapshot, self.clock(), base.get("window_quota"), f.get("claude") or {})
        src = f.get(source) or {}
        return funding.credit_state(src, self.ledger.spent(source), self.ledger.daily_rate(source, self.clock()), self.clock(),
                                    f.get("rates") or {}, base)

    # ---------- requirement and adequacy
    def requirement(self, a: dict, crit: str, failing: bool) -> float:
        """How good a model must be for this task, on the 0-5 fit scale."""
        q = self.cfg.get("quality") or {}
        c = engine.adjust_complexity(a.get("task", "qa"), a.get("complexity", 2), False, self.routing)
        r = float(c) + float((q.get("criticality_offset") or {}).get(crit, 0))
        if a.get("risk"):
            r += float(q.get("risk_offset", 0.5))
        # Only a classifier that is really unsure raises the bar (a small doubt must not push a fit-4 model out by a decimal).
        floor_u = float(q.get("uncertainty_floor", 0.3))
        unc = float(a.get("uncertainty", 0.3))
        if unc > floor_u:
            r += float(q.get("uncertainty_margin", 1.0)) * (unc - floor_u) / (1.0 - floor_u)
        if failing:
            r += float(q.get("failure_step", 1.0))
        return max(1.0, min(5.0, r))

    def adequacy(self, name: str, a: dict, need: dict, proj: str) -> tuple:
        """(score 0-5, why) for this model on this task. Every weight is in the config (`adequacy:`)."""
        w = self.cfg.get("adequacy") or {}
        spec = registry.spec(name)
        task = a.get("task", "qa")
        score = float(engine.fit_of(name, task))
        why = {"fit": score}
        gap = float(a.get("reasoning_depth", a.get("complexity", 2))) - float(spec.get("reasoning", 3))
        if gap > 0:
            p = gap * float(w.get("reasoning_gap", 0.75))
            score -= p
            why["reasoning"] = -p
        intensity = int(a.get("tool_intensity", 1)) if need.get("tools") else 0
        want_tools = {0: 0, 1: 3, 2: 4, 3: 5}.get(intensity, 4)
        tgap = want_tools - int(spec.get("tools", 0))
        if tgap > 0:
            p = tgap * float(w.get("tools_gap", 0.5))
            score -= p
            why["tools"] = -p
        if need["ctx"] > float(w.get("context_comfort", 0.5)) * int(spec["context"]):
            p = float(w.get("context_penalty", 0.5))
            score -= p
            why["context"] = -p
        bias = float(spec.get("adequacy_bias", 0) or 0)  # the owner's experience where it differs from benchmarks (models.yaml)
        if bias:
            score += bias
            why["bias"] = bias
        h = self.outcomes.adjustment(proj, task, engine.band_of(int(a.get("complexity", 2))), name,
                                     int(w.get("history_min_samples", 5)))
        if h:
            score += h
            why["history"] = round(h, 2)
        return score, why

    # ---------- candidates
    def _available(self, name: str, m: dict) -> bool:
        if not m.get("enabled", True):
            return False
        if m.get("upstream") == "gemini" and not self.env.get("GEMINI_API_KEY"):
            return False
        return name in registry.names()

    def expected_cost(self, name: str, spec: dict, m: dict, task: str, need: dict, warm: bool) -> float:
        """USD at list price for this request: context (cache-aware for Anthropic) + expected output."""
        now = datetime.fromtimestamp(self.clock(), timezone.utc)
        pr = engine.price_for(spec, need["ctx"], now)
        if not pr:
            return 0.0
        pin = pr[0] * ((0.1 if warm else 1.25) if m.get("upstream") == "anthropic" else 1.0)  # cached read vs cache write
        out = OUT_TOKENS.get(task, 2000) * float(spec.get("verbosity", 1.0)) * (2 if need.get("long_output") else 1)
        return (need["ctx"] * pin + out * pr[1]) / 1e6

    def candidates(self, a: dict, required: float, need: dict, sess: dict, proj: str) -> tuple:
        """Every allowed model with adequacy, cost and availability. -> (rows, rejected)"""
        ttl = float((self.cfg.get("switching") or {}).get("cache_ttl_s", 300))
        task = a.get("task", "qa")
        rows, rejected, states = [], {}, {}
        for name, m in (self.cfg.get("models") or {}).items():
            if not self._available(name, m):
                rejected[name] = "unavailable"
                continue
            if not safety.allowed_by_safety(name, self.settings):  # safety is a hard filter, before anything else
                rejected[name] = "safety"
                continue
            if (sess.get("sensitive") or need.get("confidential")) and not safety.allowed_for_sensitive(name, self.settings):
                rejected[name] = "sensitive"
                continue
            spec = registry.spec(name)
            if need.get("vision") and int(spec.get("vision", 0)) < 3:
                rejected[name] = "vision"
                continue
            if need["ctx"] + OUT_TOKENS.get(task, 2000) > engine.WINDOW_USE * int(spec["context"]):
                rejected[name] = "context"
                continue
            src = m.get("source", "claude")
            st = states.get(src) or states.setdefault(src, self.source_state(src))
            score, why = self.adequacy(name, a, need, proj)
            warm = self.clock() - sess["warm"].get(name, 0) < ttl
            rows.append({"name": name, "adequacy": round(score, 2), "why": why, "adequate": score >= required - 1e-9,
                         "cost": self.expected_cost(name, spec, m, task, need, warm), "warm": warm, "source": src,
                         "lambda": st["lambda"], "usable": not (st.get("exhausted") or st["lambda"] == float("inf")),
                         "vendor": spec.get("vendor", "")})
        return rows, rejected

    def choose(self, rows: list):
        """Rule 2 + 3: the cheapest adequate model; the adequate models of EQUIVALENT QUALITY to it (adequacy within
        `tie.adequacy_delta`) are its tie group, and inside the group the plan/credit balance decides: expected cost x shadow
        price. A bigger model is never in the group (its adequacy is higher), so balance never turns into a bazooka."""
        ok = [r for r in rows if r["adequate"] and r["usable"]]
        if not ok:
            return None
        ok.sort(key=lambda r: (r["cost"], -r["adequacy"]))
        first = ok[0]
        delta = float((self.cfg.get("tie") or {}).get("adequacy_delta", 0.5))
        group = [r for r in ok if abs(r["adequacy"] - first["adequacy"]) <= delta + 1e-9]
        # A source projected to run out before its reset (shadow price above 1) loses to any source that is not, whatever the
        # prices: the price gap between a small Claude and a small Gemini would otherwise hide the pressure on the plan.
        press = float((self.cfg.get("tie") or {}).get("pressure_lambda", 1.0))
        return min(group, key=lambda r: (r["lambda"] > press, r["cost"] * r["lambda"], r["cost"]))

    def effort_for(self, name: str, a: dict, bump: bool):
        spec = registry.spec(name)
        c = max(int(a.get("complexity", 2)), int(a.get("reasoning_depth", 0)))
        e = engine.default_effort(self.routing, spec, a.get("task", "qa"), max(1, min(5, c)))
        e = engine.EFFORT_CODE.get(e, e)
        if bump and e in EFFORTS and e != "high":
            e = EFFORTS[EFFORTS.index(e) + 1]
        return e

    # ---------- the decision
    def decide(self, req: dict, headers: dict) -> dict:
        """-> {"action": "forward"|"answer", "model", "upstream", "id", "effort", "reason", "text" (answer), ...}"""
        h = {k.lower(): v for k, v in (headers or {}).items()}
        rclass = h.get("x-claude-code-request-class", "main")
        agent = h.get("x-claude-code-agent-type", "")
        sid = h.get("x-claude-code-session-id") or "nosession"
        prompt_id = h.get("x-claude-code-prompt-id")
        requested = req.get("model") or ""
        models = self.cfg.get("models") or {}
        by_id = {m["id"]: n for n, m in models.items()}
        messages = req.get("messages") or []

        if rclass == "auxiliary" or (rclass == "subagent" and agent == "Explore"):
            name = (self.cfg.get("classes") or {}).get("auxiliary" if rclass == "auxiliary" else "explore", "claude-haiku-cli")
            return self._simple(name, rclass)
        key = sid if rclass == "main" else sid + ":" + rclass + ":" + hashlib.sha256(first_prompt(messages)[:300].encode()).hexdigest()[:12]
        sess = self._session(key)
        if rclass == "compaction":  # the summary reads the whole conversation: the model whose cache is warm reads it cheapest
            name = sess.get("model") or by_id.get(self.cfg.get("auto_model")) or "claude-sonnet-cli"
            if self._unusable(name):
                name = self._simple(name, rclass)["model"]
            return self._finish(sess, name, None, "compaction", {"task": sess.get("task", "qa")}, 0)

        self._sensitivity(sess, messages)
        text = last_prompt(messages)
        cwd = working_dir(req)
        proj = project_key(cwd)
        pol = project_policy(cwd)
        crit = pol.get("criticality", "normal")
        need = {"tools": bool(req.get("tools")), "vision": has_image(messages), "ctx": est_tokens(req),
                "confidential": bool(pol.get("confidential"))}
        new_prompt = prompt_id != sess.get("prompt_id") if prompt_id else policy.signals_anthropic(messages)["steps"] == 0
        pin_match = PIN_RE.search(text or "") if new_prompt else None
        sw = dict(policy.DEFAULT_SWITCHING)
        sw.update(self.routing.get("switching") or {})
        sw.update(self.cfg.get("switching") or {})

        claude = self.source_state("claude")
        # A Claude model chosen explicitly in the picker is a pin: sent as asked (the person decided) unless the plan is out,
        # where sending it would be billed as extra usage: then `auto` decides (and asks when only Claude is adequate).
        if requested and requested != self.cfg.get("auto_model") and requested in by_id and not self._unusable(by_id[requested]):
            sess.update(prompt_id=prompt_id, model=by_id[requested])
            return self._finish(sess, by_id[requested], None, "picker pin", {"task": "pinned"}, 0, keep_effort=True)
        if new_prompt:
            self._close_prompt(sess, proj)
            sess["prompt_id"] = prompt_id
            choice = (text or "").strip().lower()
            pend = sess.get("pending") or {}
            if pend and choice in ("1", "!gemini") and pend.get("suggest"):
                p = sess.pop("pending")  # 1: the best available model now (Gemini), until the plan is back
                sess.update(a=p["a"], task=p["a"]["task"], hold_until=claude.get("until") or self.clock() + 3600, hold=p["suggest"])
                return self._finish(sess, p["suggest"], None, "chosen: best available now (Claude plan exhausted)", p["a"], p["req"])
            if pend and choice == "2" and pend.get("overage"):
                p = sess.pop("pending")  # 2: Claude's paid extra usage (the person's emergency reserve), until the plan is back
                sess.update(a=p["a"], task=p["a"]["task"], hold_until=claude.get("until") or self.clock() + 3600, hold=p["overage"])
                return self._finish(sess, p["overage"], None, "chosen: Claude extra usage (paid, emergency)", p["a"], p["req"])
            if (pend and choice == "3") or (pin_match and pin_match.group(1).lower() in ("esperar", "wait")):
                sess.pop("pending", None)  # 3: wait and resume automatically when the plan resets
                return self._queue_resume(sess, sid, cwd, claude, auto=True)
            if pend and choice == "4":
                sess.pop("pending", None)  # 4: stop; only a notification when the plan is back, the person continues by hand
                return self._queue_resume(sess, sid, cwd, claude, auto=False)
            sess.pop("pending", None)
            if pin_match and pin_match.group(1).lower() in TEXT_PINS:
                name = TEXT_PINS[pin_match.group(1).lower()]
                if name in models and self._available(name, models[name]) and not self._unusable(name) and \
                        safety.allowed_by_safety(name, self.settings) and \
                        (not sess.get("sensitive") or safety.allowed_for_sensitive(name, self.settings)):
                    sess.update(pin=name)
                    return self._finish(sess, name, None, f"text pin !{pin_match.group(1)}", {"task": "pinned"}, 0)
            sess.pop("pin", None)
            card = project_card(cwd)
            a = self.classify((text or first_prompt(messages)) + (f"\n\n[Project]\n{card}" if card else ""), checkpoint=False,
                              sensitive=sess.get("sensitive", False))
            sess.update(a=a, task=a["task"], last_eval_step=0, steps_since_switch=0, down_votes=0, steps=0, switch_step=0,
                        failed=False, proj=proj)
            failing = False
        else:
            if sess.get("pin") and not self._unusable(sess["pin"]):
                return self._finish(sess, sess["pin"], None, "pin (same prompt)", {"task": "pinned"}, 0)
            if sess.get("hold") and sess.get("hold_until", 0) > self.clock():
                return self._finish(sess, sess["hold"], None, "chosen while Claude is out", sess.get("a") or {}, sess.get("req", 0))
            a = sess.get("a") or self.classify(first_prompt(messages), checkpoint=False, sensitive=sess.get("sensitive", False))
            sig = policy.signals_anthropic(messages)
            sess["steps"] = sig["steps"]
            sess["steps_since_switch"] = sig["steps"] - sess.get("switch_step", 0)  # tool steps, not HTTP calls
            failing = policy.failing(sig)
            if sess.get("model") and not policy.needs_checkpoint(sess, sig, sw) and not self._unusable(sess["model"]):
                return self._finish(sess, sess["model"], None, "same task", a, sess.get("req", 0), effort=sess.get("effort"))
            sess["last_eval_step"] = sig["steps"]
            if failing:
                sess["failed"] = True
                if sess.get("model"):  # the model in use could not do it: an outcome to learn from
                    self.outcomes.record(proj, a.get("task", "qa"), engine.band_of(int(a.get("complexity", 2))), sess["model"], False)
            else:
                a = dict(self.classify(self._checkpoint_text(messages), checkpoint=True, sensitive=sess.get("sensitive", False)))
                a["task"] = a.get("task") or sess.get("task", "qa")
                sess["a"] = a

        if sess.get("hold") and sess.get("hold_until", 0) > self.clock() and new_prompt:
            return self._finish(sess, sess["hold"], None, "chosen while Claude is out", a, sess.get("req", 0))
        required = self.requirement(a, crit, failing)
        rows, rejected = self.candidates(a, required, need, sess, proj)
        pick = self.choose(rows)
        cur = sess.get("model")

        if pick is None:
            blocked = [r for r in rows if r["adequate"] and not r["usable"]]
            usable = sorted([r for r in rows if r["usable"]], key=lambda r: (-r["adequacy"], r["cost"]))
            if blocked and claude.get("exhausted"):
                ex = self.cfg.get("on_claude_exhausted") or {}
                if ex.get("ask", True) and new_prompt:
                    best_blocked = sorted(blocked, key=lambda r: r["cost"])[0]["name"]
                    return self._ask(sess, a, required, usable[:1], claude, best_blocked)
            if not usable:
                return {"action": "answer", "reason": "no model", "text": self._no_model_text(rejected, rows), "status": 503}
            pick = dict(usable[0], below=True)  # nobody reaches the requirement: the most adequate one that can answer

        if not new_prompt and cur and cur != pick["name"] and not failing:
            cur_row = next((r for r in rows if r["name"] == cur), None)
            if cur_row and cur_row["adequate"] and cur_row["usable"]:
                cheaper = pick["cost"] < cur_row["cost"]  # pick's cost already includes its cold cache; cur's is warm
                if not cheaper or not policy.downgrade_allowed(sess, {"steps": 0}, False, sw):
                    pick = cur_row  # the current model is still adequate: stay unless the move is confirmed and pays
        cur_row = next((r for r in rows if r["name"] == cur), None)
        if new_prompt:
            reason = "new prompt"
        elif pick["name"] == cur:
            reason = "checkpoint: keep"
        elif failing:
            reason = "escalated: tool errors / loop"
        elif cur_row and not cur_row["adequate"]:
            reason = "checkpoint: current no longer adequate"
        else:
            reason = "checkpoint: cheaper adequate"
        if failing:
            sess["down_votes"] = 0
        sess["req"] = required
        return self._finish(sess, pick["name"], rows, reason, a, required, bump=failing, below=pick.get("below", False))

    # ---------- helpers
    def _unusable(self, name: str) -> bool:
        m = (self.cfg.get("models") or {}).get(name) or {}
        return bool(self.source_state(m.get("source", "claude")).get("exhausted"))

    def _close_prompt(self, sess: dict, proj: str):
        """A new prompt means the previous one ended; if its model was never escalated away, count a success."""
        a = sess.get("a")
        if a and sess.get("model") and not sess.get("failed") and not sess.get("pin") and a.get("task") != "pinned":
            self.outcomes.record(sess.get("proj", proj), a.get("task", "qa"), engine.band_of(int(a.get("complexity", 2))),
                                 sess["model"], True)

    def _sensitivity(self, sess: dict, messages: list):
        if self.settings.get("sensitive_guard") != "on":
            return
        try:  # detection only: the request body is never changed (it would break the prompt cache and thinking)
            r = dlp.scan_and_mask({"messages": copy.deepcopy(messages[-2:])}, dict(self.settings, mask_secrets="off", mask_pii="off"))
            if r.sensitive:
                sess["sensitive"] = True
                sess["kinds"].update(r.kinds)
        except Exception:
            if self.settings.get("fail_mode") == "closed":
                sess["sensitive"] = True

    def _checkpoint_text(self, messages: list) -> str:
        lines = []
        for m in messages[-8:]:
            for b in _blocks(m.get("content")):
                if b.get("type") == "text":
                    lines.append(f"{m.get('role')}: {b.get('text', '')[:600]}")
                elif b.get("type") == "tool_use":
                    lines.append(f"tool_use {b.get('name')}: {json.dumps(b.get('input'), ensure_ascii=False)[:300]}")
                elif b.get("type") == "tool_result":
                    c = b.get("content")
                    t = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
                    lines.append(("tool_error: " if b.get("is_error") else "tool_result: ") + t[:300])
        return f"Original request:\n{first_prompt(messages)[:1500]}\n\nLatest steps:\n" + "\n".join(lines)[-4000:]

    def _simple(self, name: str, rclass: str) -> dict:
        """Auxiliary requests (titles, summaries) and the Explore subagent: a fixed small model; if its source is out, the cheapest
        available model of another source."""
        models = self.cfg.get("models") or {}
        if self._unusable(name) or not self._available(name, models.get(name) or {}):
            alt = [n for n, m in models.items() if self._available(n, m) and not self._unusable(n)
                   and safety.allowed_by_safety(n, self.settings)]
            if alt:
                now = datetime.fromtimestamp(self.clock(), timezone.utc)
                name = min(alt, key=lambda n: engine.price_for(registry.spec(n), 0, now) or (0, 0))
        m = models.get(name) or {}
        return {"action": "forward", "model": name, "upstream": m.get("upstream", "anthropic"), "id": m.get("id"), "effort": None,
                "reason": rclass, "class": rclass}

    def _finish(self, sess, name, rows, reason, a, required, bump=False, effort=None, keep_effort=False, below=False) -> dict:
        m = (self.cfg.get("models") or {}).get(name) or {}
        task = a.get("task", "qa")
        if not keep_effort and effort is None and task != "pinned":
            effort = self.effort_for(name, a, bump)
        prev = sess.get("model")
        sess.update(model=name, effort=effort)
        if prev != name:
            sess["steps_since_switch"] = 0
            sess["switch_step"] = sess.get("steps", 0)
        sess["warm"][name] = self.clock()
        row = next((x for x in rows or [] if x["name"] == name), None)
        return {"action": "forward", "model": name, "upstream": m.get("upstream", "anthropic"), "id": m.get("id"), "effort": effort,
                "reason": reason, "task": task, "complexity": a.get("complexity"), "reasoning_depth": a.get("reasoning_depth"),
                "uncertainty": a.get("uncertainty"), "required": round(required, 2) if required else None,
                "adequacy": row and row["adequacy"], "below": below, "switched_from": prev if prev and prev != name else None,
                "lambda": row and round(row["lambda"], 3), "est_cost": row and round(row["cost"], 5), "source": row and row["source"],
                "sensitive": sess.get("sensitive"), "analysis": a.get("source"),
                "candidates": [(r["name"], r["adequacy"], round(r["cost"], 5), r["adequate"], r["usable"])
                               for r in sorted(rows or [], key=lambda r: r["cost"])][:6]}

    def _ask(self, sess, a, required, usable, claude, claude_model=None) -> dict:
        """The plan is out and only a Claude model is adequate: four choices, numbered the same way every time (an option that is
        not possible right now is left out, never renumbered)."""
        until = claude.get("until")
        when = datetime.fromtimestamp(until).strftime("%H:%M") if until else "?"
        day = datetime.fromtimestamp(until).strftime("%d/%m") if until else ""
        today = datetime.fromtimestamp(self.clock()).strftime("%d/%m")
        when_txt = when if day == today else f"{day} {when}"
        g = usable[0] if usable else None
        overage = self._overage_option(claude, claude_model)
        sess["pending"] = {"a": a, "req": required, "suggest": g and g["name"], "overage": overage}
        lines = [f"⏸ A cota do Claude acabou até **{when_txt}**, e o modelo adequado para esta tarefa ({a.get('task')}, "
                 f"complexidade {a.get('complexity')}) é do Claude ({claude_model or 'Claude'}). Responda com o número:", ""]
        if g:
            left = self.source_state(g["source"]).get("remaining_usd")
            lines.append(f"- **1** — usar agora o **{g['name']}**, o melhor disponível (adequação {g['adequacy']:.1f} para um requisito "
                         f"de {required:.1f}; ≈ US$ {g['cost']:.2f}" + (f"; crédito restante ≈ US$ {left:.2f}" if left is not None else "") + ")")
        if overage:
            lines.append(f"- **2** — usar os **créditos do Claude** (uso extra pago, sua reserva de emergência) com o {overage}")
        lines.append(f"- **3** — esperar a cota reiniciar ({when_txt}): retomo esta sessão sozinho e aviso com uma notificação")
        lines.append(f"- **4** — parar aqui: aviso quando a cota voltar e você manda continuar quando quiser")
        return {"action": "answer", "reason": "Claude plan exhausted: asked", "text": "\n".join(lines), "status": 200,
                "task": a.get("task"), "complexity": a.get("complexity")}

    def _overage_option(self, claude: dict, claude_model):
        """Claude's paid extra usage is offered (option 2) only when Anthropic would serve it and the config says `ask`."""
        mode = ((self.cfg.get("funding") or {}).get("claude") or {}).get("overage", "never")
        return claude_model if claude_model and claude.get("overage") and mode == "ask" else None

    def _queue_resume(self, sess, sid, cwd, claude, auto: bool = True) -> dict:
        ex = self.cfg.get("on_claude_exhausted") or {}
        until = (claude.get("until") or self.clock() + 3600) + float(ex.get("resume_margin_s", 120))
        when = datetime.fromtimestamp(until).strftime("%d/%m %H:%M")
        if auto and (not ex.get("resume", True) or not cwd or sid == "nosession"):
            auto = False  # cannot resume this session by itself: fall back to a notification
        self.resume_queue = [r for r in self.resume_queue if r["session"] != sid]
        self.resume_queue.append({"session": sid, "cwd": cwd, "at": until, "queued": self.clock(), "mode": "resume" if auto else "notify"})
        if auto:
            return {"action": "answer", "reason": "resume queued", "status": 200, "resume": self.resume_queue[-1],
                    "text": f"⏸ Combinado. Retomo esta sessão sozinho por volta de **{when}**, quando a cota do Claude voltar, "
                            "e aviso com uma notificação. Ao reabrir a sessão você vê o que foi feito."}
        return {"action": "answer", "reason": "stopped: notify only", "status": 200, "resume": self.resume_queue[-1],
                "text": f"⏹ Parado. Aviso com uma notificação quando a cota do Claude voltar (por volta de **{when}**); "
                        "aí é só mandar continuar."}

    def _no_model_text(self, rejected: dict, rows: list) -> str:
        why = ", ".join(f"{k}: {v}" for k, v in sorted(rejected.items()))
        out = ", ".join(r["name"] for r in rows if not r["usable"])
        return "Nenhum modelo pode atender este pedido agora (" + "; ".join(x for x in (why, out and f"sem cota: {out}") if x) + ")."
