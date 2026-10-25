"""Routing v3 decision engine. Pure Python (no LiteLLM import) so it is unit-testable anywhere.

route() turns (profile, task, complexity, request needs, safety state) into an ordered list of concrete model names:
  1. take routes[profile][task][band] from routing.yaml (the source of truth)
  2. filter: safety -> sensitivity -> availability -> profile -> tools -> vision -> context -> health -> budget
  3. reorder neighbours of similar quality by effective cost (subscription models get cheaper while the plan has room)
  4. quality floor, excess rule (expensive model not needed) and, for `smart`, the upgrade rule
  5. empty list -> capability matrix -> profile safety net -> RouteBlocked (never a higher profile, never weaker safety)
Facts about models (price, fit, privacy ...) come from registry/models.yaml; nothing about a vendor is hard-coded here.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone

import registry
import safety

BANDS = ("c1-2", "c3", "c4-5")
TASKS = ("qa", "explain_code", "codegen", "feature", "frontend", "refactor", "debug", "test_review", "architecture",
         "data", "doc_tech", "writing", "research_long", "mechanical")
FIT_TASK = {"mechanical": "codegen"}  # the capability matrix has no column for already-decided agent steps
OUTPUT_TOKENS = {"qa": 500, "explain_code": 1200, "codegen": 1500, "feature": 6000, "frontend": 4000, "refactor": 5000,
                 "debug": 3000, "test_review": 4000, "architecture": 3000, "data": 2000, "doc_tech": 3000, "writing": 2500,
                 "research_long": 2500, "mechanical": 800}
SUCCESS_BY_SLACK = {-1: 0.6, 0: 0.75, 1: 0.9}  # slack = fit - floor; >= 2 -> 0.95
WINDOW_USE = 0.85
DEFAULT_OVERHEAD = 20000
EFFORT_CODE = {"xhigh": "high"}  # accepted in the tables, sent as high until provider support for xhigh is verified


class RouteBlocked(Exception):
    """No allowed model. str(e) is the message for the user (Portuguese)."""

    def __init__(self, message: str, reason: str = "none"):
        super().__init__(message)
        self.reason = reason


@dataclass
class Need:
    tools: bool = False
    vision: bool = False
    ctx_tokens: int = 0
    long_output: bool = False
    out_tokens: int = 0  # 0 = use the task default


@dataclass
class Env:
    """Everything outside the tables the engine needs, injected so tests can control it."""
    settings: dict
    sensitive: bool = False
    kinds: dict = field(default_factory=dict)
    resolve: object = staticmethod(lambda alias_or_name: alias_or_name)   # alias/model_name -> concrete model_name
    available: object = staticmethod(lambda name: True)                   # configured, key/login present, pool member verified
    health: object = staticmethod(lambda name: "ok")                      # ok|unknown|warn|critical|exhausted (breaker included)
    utilization: object = staticmethod(lambda name: None)                 # subscription window use 0-1, None = unknown
    spent_today: float = 0.0
    now: datetime = None


@dataclass
class Candidate:
    name: str
    alias: str
    effort: object = None
    warn: bool = False
    escalate_only: bool = False
    fit: int = 0
    slack: int = 0
    cost: float = 0.0          # real money for this request (USD): 0 for subscriptions and free models
    eff_cost: float = 0.0      # API-equivalent cost x scarcity (ordering only)
    exp_cost: float = 0.0      # eff_cost / probability of success
    vendor: str = ""
    below: bool = False        # fit == floor - 1: below the recommended level
    subscription: bool = False


@dataclass
class Decision:
    model: str
    effort: str
    task: str
    complexity: int
    band: str
    floor: int
    profile: str
    fallbacks: list
    source: str = "table"      # table | matrix | safety_net
    warn: bool = False
    below: bool = False
    est_cost: float = 0.0
    alias: str = ""
    notes: list = field(default_factory=list)
    candidates: list = field(default_factory=list)

    def public(self) -> dict:
        return {"model": self.model, "effort": self.effort, "task": self.task, "complexity": self.complexity, "band": self.band,
                "floor": self.floor, "source": self.source, "warn": self.warn, "below": self.below,
                "est_cost": round(self.est_cost, 5), "fallbacks": list(self.fallbacks), "notes": list(self.notes)}


# ------------------------------------------------------------------ loading and validation
def band_of(c: int) -> str:
    return "c1-2" if c <= 2 else "c3" if c == 3 else "c4-5"


def band_floor(band: str) -> int:
    return {"c1-2": 1, "c3": 3, "c4-5": 4}[band]


def validate(routing: dict, model_names=None) -> list:
    """Return a list of problems (empty = valid). Checks shape, aliases and that every cell has >= 2 candidates that are not `unsafe`."""
    errs = []
    for key in ("profiles", "routes", "aliases"):
        if not isinstance(routing.get(key), dict):
            errs.append(f"missing section: {key}")
    if errs:
        return errs
    aliases = routing["aliases"]
    for p in ("free", "balanced", "smart"):
        prof = (routing["profiles"] or {}).get(p)
        if not prof:
            errs.append(f"profiles.{p} missing")
            continue
        for k in ("offset", "ceiling", "max_usd_request", "max_usd_day", "allow_paid", "allow_subscription"):
            if k not in prof:
                errs.append(f"profiles.{p}.{k} missing")
        if p not in routing["routes"]:
            errs.append(f"routes.{p} missing")
    for p, tasks in routing["routes"].items():
        for task, cells in (tasks or {}).items():
            if task not in TASKS:
                errs.append(f"routes.{p}.{task}: unknown task")
            for band, items in (cells or {}).items():
                if band == "escalate":
                    pass
                elif band not in BANDS:
                    errs.append(f"routes.{p}.{task}.{band}: unknown band")
                    continue
                for it in items:
                    alias = it["model"] if isinstance(it, dict) else it
                    if alias not in aliases and alias not in (model_names or []):
                        errs.append(f"routes.{p}.{task}.{band}: unknown alias {alias}")
    return errs


def _items(cell) -> list:
    out = []
    for it in cell or []:
        if isinstance(it, str):
            it = {"model": it}
        out.append(dict(it))
    return out


# ------------------------------------------------------------------ prices and costs
def _now(env) -> datetime:
    return env.now or datetime.now(timezone.utc)


def _in_window(now: datetime, window) -> bool:
    """window = ["16:30", "00:30"] (UTC, may wrap midnight)."""
    try:
        a, b = [tuple(int(x) for x in w.split(":")) for w in window]
    except Exception:
        return False
    t, lo, hi = (now.hour, now.minute), a, b
    return lo <= t < hi if lo <= hi else (t >= lo or t < hi)


def price_for(spec: dict, prompt_tokens: int, now: datetime):
    """(price_in, price_out) USD per 1M tokens in force now, or None for models without a price (free)."""
    p = spec.get("price")
    if not p:
        return None
    pin, pout = p["in"], p["out"]
    for s in sorted(p.get("schedule") or [], key=lambda x: str(x["from"])):
        if now.strftime("%Y-%m-%d") >= str(s["from"]):
            pin, pout = s["in"], s["out"]
    off = p.get("offpeak")
    if off and p.get("offpeak_utc") and _in_window(now, p["offpeak_utc"]):
        pin, pout = off["in"], off["out"]
    lc = p.get("long_context")
    if lc and prompt_tokens > lc["above"]:
        pin, pout = lc["in"], lc["out"]
    return pin, pout


def api_cost(name: str, need: Need, task: str, now: datetime) -> float:
    """USD the same request would cost through the API: (context + CLI overhead) x input price + output x verbosity x output price."""
    spec = registry.spec(name)
    overhead = int(spec.get("overhead_cli", 0) or 0) if spec.get("subscription") else 0
    prompt = need.ctx_tokens + overhead
    pr = price_for(spec, prompt, now)
    if not pr:
        return 0.0
    out = (need.out_tokens or OUTPUT_TOKENS.get(task, 2000)) * float(spec.get("verbosity", 1.0))
    if need.long_output:
        out *= 2
    return (prompt * pr[0] + out * pr[1]) / 1e6


def _fit(spec: dict, task: str) -> int:
    return int((spec.get("fit") or {}).get(FIT_TASK.get(task, task), 0))


def scarcity_factor(routing: dict, util):
    """Multiplier for a subscription model; None = the plan is nearly used up (removed)."""
    sc = routing.get("scarcity") or {"below_50": 0.25, "below_80": 0.6, "above_80": 1.5}
    if util is None:
        return sc.get("below_80", 0.6)  # unknown use: middle value
    if util >= 0.95:
        return None
    return sc["below_50"] if util < 0.5 else sc["below_80"] if util <= 0.8 else sc["above_80"]


# ------------------------------------------------------------------ filters
def reject_reason(name: str, spec: dict, env: Env, prof: dict, need: Need, task: str, c: int, escalating: bool, relax_tools: bool = False):
    """First filter a candidate fails, or None. Order matters: safety and sensitivity first."""
    s = env.settings
    if not safety.allowed_by_safety(name, s):
        return "safety"
    if env.sensitive and not safety.allowed_for_sensitive(name, s):
        return "sensitive"
    if not env.available(name):
        return "unavailable"
    if spec.get("subscription"):
        if not prof.get("allow_subscription"):
            return "profile"
    elif spec.get("paid"):
        if not prof.get("allow_paid"):
            return "profile"
    if need.tools and int(spec.get("tools", 0)) < (4 if c >= 3 else 3) - (1 if relax_tools else 0):
        return "tools"
    if need.vision and int(spec.get("vision", 0)) < 3:
        return "vision"
    lim = spec.get("limits") or {}
    window = min(int(spec["context"]), int(lim["tpm"])) if lim.get("tpm") else int(spec["context"])
    out = need.out_tokens or OUTPUT_TOKENS.get(task, 2000)
    overhead = int(spec.get("overhead_cli", 0) or 0) if spec.get("subscription") else 0
    if need.ctx_tokens + overhead + out > WINDOW_USE * window:
        return "context"
    if env.health(name) in ("critical", "exhausted"):
        return "health"
    return None


# ------------------------------------------------------------------ the decision
def adjust_complexity(task: str, c: int, risk: bool, routing: dict) -> int:
    adj = routing.get("task_adjust") or {}
    c = int(c)
    if task == "mechanical":
        return 1
    c += int(adj.get(task, 0))
    if task == "debug" and c >= 3:
        c += int(adj.get("debug_if_c3plus", 1)) - int(adj.get("debug", 0))
    if risk:
        c += int(adj.get("risk", 1))
    return max(1, min(5, c))


def default_effort(routing: dict, spec: dict, task: str, c: int):
    table = (routing.get("effort_default") or {}).get(spec.get("abbr"))
    if not table:
        return None
    if c <= 2:
        e = table.get("c1-2")
        if e and task in (table.get("light_tasks") or []):
            e = table.get("light", e)
        return e
    return table.get("c3") if c == 3 else table.get(f"c{c}")


def _effort(routing: dict, item_effort, spec: dict, task: str, c: int):
    e = item_effort[c] if isinstance(item_effort, dict) and c in item_effort else (None if isinstance(item_effort, dict) else item_effort)
    if e is None:
        e = default_effort(routing, spec, task, c)
    return e


def _build(routing, env, prof, need, task, c, floor, items, escalating, avoid_vendor=None, relax_tools=False):
    now = _now(env)
    out, rejected = [], {}
    seen = set()
    for it in items:
        alias = it["model"]
        name = env.resolve(routing["aliases"].get(alias, alias))
        if name in seen:
            continue
        seen.add(name)
        spec = registry.spec(name)
        if name not in registry.names() or spec.get("internal"):
            rejected[name] = "unknown"
            continue
        why = reject_reason(name, spec, env, prof, need, task, c, escalating, relax_tools)
        if why is None and it.get("escalate_only") and spec.get("subscription"):
            limit = prof.get("escalate_only_below_utilization")
            u = env.utilization(name)
            if limit is not None and (u is None or u >= limit):  # unknown use counts as scarce: Opus only with proven room
                why = "scarce"
        factor = 1.0
        if why is None and spec.get("subscription"):
            factor = scarcity_factor(routing, env.utilization(name))
            if factor is None:
                why = "health"
        if why is None:
            real = 0.0 if (spec.get("subscription") or not spec.get("paid")) else api_cost(name, need, task, now)
            if spec.get("paid") and not spec.get("subscription"):
                if prof.get("max_usd_request") is not None and real > float(prof["max_usd_request"]):
                    why = "budget"
                elif env.spent_today >= float(prof.get("max_usd_day") or 0):
                    why = "budget"
        if why:
            rejected[name] = why
            continue
        fit = _fit(spec, task)
        slack = fit - floor
        if slack < -1:
            rejected[name] = "fit"
            continue
        eff = api_cost(name, need, task, now) * factor
        p = SUCCESS_BY_SLACK.get(slack, 0.95) if slack < 2 else 0.95
        out.append(Candidate(name=name, alias=alias, effort=_effort(routing, it.get("effort"), spec, task, c), warn=bool(it.get("warn")),
                             escalate_only=bool(it.get("escalate_only")), fit=fit, slack=slack, cost=real, eff_cost=eff,
                             exp_cost=eff / p, vendor=spec.get("vendor", ""), below=slack < 0,
                             subscription=bool(spec.get("subscription"))))
    return out, rejected


def _swap_neighbours(cands: list) -> list:
    """Subscription vs API neighbours whose fit differs by <= 1: put the one that is cheaper to use first (so a plan with room is used
    before billed calls, and a nearly used-up plan after them). Each candidate moves at most one place."""
    cands = list(cands)
    i = 0
    while i < len(cands) - 1:
        a, b = cands[i], cands[i + 1]
        if abs(a.fit - b.fit) <= 1 and a.subscription != b.subscription and not a.below and not b.below and b.eff_cost < a.eff_cost:
            cands[i], cands[i + 1] = b, a
            i += 2
        else:
            i += 1
    return cands


def _excess(cands: list) -> list:
    if not cands:
        return cands
    first = cands[0]
    if first.slack >= 2:
        cheaper = [x for x in cands[1:] if x.slack >= 0 and x.eff_cost <= first.eff_cost / 3]
        if cheaper:
            best = min(cheaper, key=lambda x: x.eff_cost)
            return [best] + [x for x in cands if x is not best]
    return cands


def _upgrade(cands: list) -> list:
    if len(cands) > 1 and cands[1].fit >= cands[0].fit + 1 and cands[1].exp_cost <= 2.5 * cands[0].exp_cost:
        return [cands[1], cands[0]] + cands[2:]
    return cands


def _diversify(cands: list) -> list:
    """If the first two fallbacks come from the primary's vendor, bring the first other vendor to position 1."""
    if len(cands) < 4:
        return cands
    head = cands[0].vendor
    if cands[1].vendor == head and cands[2].vendor == head:
        for i in range(3, len(cands)):
            if cands[i].vendor != head:
                return [cands[0], cands[i]] + [x for j, x in enumerate(cands) if j not in (0, i)]
    return cands


def blocked_message(env: Env, profile: str, task: str) -> str:
    if env.sensitive:
        what = ", ".join(sorted(env.kinds)) or "dados sensíveis"
        return (f"Conteúdo sensível detectado ({what}). Nenhum modelo permitido para {profile}. "
                "Use Auto: Balanced/Smart, remova os dados ou ajuste SENSITIVE_ALLOWED_CLASSES.")
    return f"Nenhum modelo disponível para {task} no perfil {profile}."


def route(routing: dict, profile: str, task: str, complexity: int, env: Env, need: Need = None, risk: bool = False,
          escalate: bool = False, avoid_vendor: str = None, prefer: str = None) -> Decision:
    """Pick the model for one request. `escalate`: failure signals, use the band above (+ the cell's escalation list).
    `prefer`: the model already working on this task; kept first if it still passes every filter (no needless switching)."""
    need = need or Need()
    prof = routing["profiles"][profile]
    task = task if task in TASKS else "qa"
    c = adjust_complexity(task, complexity, risk, routing)
    base_band = band_of(c)
    floor = max(1, min(int(prof["ceiling"]), c + int(prof["offset"])))
    cell = (routing["routes"][profile].get(task) or {})
    notes = []

    band = base_band
    if escalate and base_band != "c4-5":
        band = BANDS[BANDS.index(base_band) + 1]
        notes.append(f"escalated to band {band}")
    items = _items(cell.get(band) or cell.get("c1-2"))
    if escalate:
        items = items + [dict(x, escalate_only=True) for x in _items(cell.get("escalate"))]
        if escalate and base_band == "c4-5":
            notes.append("escalated")
    rejected_all = {}
    cands, rej = _build(routing, env, prof, need, task, c, floor, items, escalate, avoid_vendor)
    rejected_all.update(rej)
    source = "table"
    ok = [x for x in cands if not x.below]
    weak = [x for x in cands if x.below]
    cands = _swap_neighbours(ok)
    cands = _excess(cands)
    if profile == "smart":
        cands = _upgrade(cands)
    if escalate and avoid_vendor and task == "debug":  # a second opinion from another vendor comes first
        cands = [x for x in cands if x.vendor != avoid_vendor] + [x for x in cands if x.vendor == avoid_vendor]
    cands = cands + weak

    if not cands:
        source = "matrix"
        pool = []
        for name in registry.names():
            spec = registry.spec(name)
            if spec.get("pin_only") or spec.get("internal"):
                continue
            pool.append({"model": name})
        cands, rej = _build(routing, env, prof, need, task, c, floor, pool, escalate, avoid_vendor)
        rejected_all.update(rej)
        cands.sort(key=lambda x: x.exp_cost)
    if not cands:
        source = "safety_net"
        key = "safety_net_on" if env.settings.get("safety_mode") == "on" else "safety_net_off"
        net = [{"model": a} for a in (prof.get(key) or [])]
        cands, rej = _build(routing, env, prof, need, task, c, floor, net, escalate, avoid_vendor, relax_tools=True)
        rejected_all.update(rej)
        if cands and need.tools and any(int(registry.spec(x.name).get("tools", 0)) < (4 if c >= 3 else 3) for x in cands):
            notes.append("tool calls less reliable than recommended")
    if not cands:
        raise RouteBlocked(blocked_message(env, profile, task), reason="sensitive" if env.sensitive else "none")

    if prefer:
        for x in cands:
            if x.name == prefer and not x.below:
                cands = [x] + [y for y in cands if y is not x]
                break
    cands = [cands[0]] + _diversify(cands)[1:] if len(cands) > 1 else cands
    chosen = cands[0]
    if chosen.below:
        notes.append("below recommended")
    return Decision(model=chosen.name, effort=EFFORT_CODE.get(chosen.effort, chosen.effort), task=task, complexity=c, band=band,
                    floor=floor, profile=profile, fallbacks=[x.name for x in cands[1:5]], source=source, warn=chosen.warn,
                    below=chosen.below, est_cost=chosen.cost, alias=chosen.alias, notes=notes,
                    candidates=[(x.name, x.fit, round(x.exp_cost, 5)) for x in cands[:6]])


def cost_of(routing: dict, env: Env, name: str, task: str, need: Need) -> float:
    """API-equivalent cost of a request on `name` (for the mechanical-step saving rule)."""
    return api_cost(name, need, task, _now(env))


def fit_of(name: str, task: str) -> int:
    return _fit(registry.spec(name), task)


def direction(env: Env, cur: str, target: str, task: str, need: Need) -> int:
    """+1 / 0: moving to `target` is an upgrade or sideways (allowed at once); -1: a downgrade (needs confirmation)."""
    fc, ft = fit_of(cur, task), fit_of(target, task)
    if ft != fc:
        return 1 if ft > fc else -1
    return -1 if cost_of(None, env, target, task, need) < cost_of(None, env, cur, task, need) else 0


def switch_saving_ok(env: Env, cur: str, target: str, task: str, need: Need) -> bool:
    """Mechanical steps: leave the current model (its cache) only if the saving exceeds re-sending the context to the new one."""
    saving = cost_of(None, env, cur, task, need) - cost_of(None, env, target, task, need)
    pr = price_for(registry.spec(target), need.ctx_tokens, _now(env))
    return saving > (need.ctx_tokens * pr[0] / 1e6 if pr else 0.0)
