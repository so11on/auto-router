"""Where a call's cost comes from, and how much that source "costs" right now (its shadow price λ). Stdlib only.

The router minimises  tokens x price x λ(source), not the list price (docs/ROADMAP.md, 3b). Source kinds:
  window_quota     a plan that resets (Claude 5 h + 7 d windows): unused allowance is lost at the reset, so while the plan is
                   running below its ideal pace λ falls towards 0; above it λ climbs past 1 to keep the plan for what only it can do
  expiring_credit  credit lots with their own end dates (Google AI Pro monthly credits): spent oldest-first; λ falls towards 0 only when
                   a lot is about to expire with money left that the current spending pace will not use
  prepaid_balance  money already paid that does not expire (Cloud Billing prepayment): medium λ
  payg             real money on a card: λ 1, and only if the user allows it

Pure functions plus one small ledger (data/gateway-spend.json). Every number that tunes the curve is in the config, not here.
"""
import json
import os
import time
from datetime import datetime, timezone

DEFAULT_BASE = {"window_quota": 0.2, "expiring_credit": 0.4, "prepaid_balance": 0.8, "payg": 1.0}
WINDOWS = {"5h": 5 * 3600, "7d": 7 * 86400}
EXHAUSTED_AT = 0.99


def _ts(value) -> float:
    """Epoch seconds from an int/float/str epoch or an ISO date (end of that day, UTC)."""
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if s.replace(".", "", 1).isdigit():
        return float(s)
    d = datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    if len(s) == 10:  # a bare date means "until the end of that day"
        return d.timestamp() + 86399
    return d.timestamp()


# ------------------------------------------------------------------ Claude plan windows (from anthropic-ratelimit-unified-*)
def parse_unified(headers: dict, now: float = None) -> dict:
    """Plan usage from a response's `anthropic-ratelimit-unified-*` headers -> {"5h": {...}, "7d": {...}, "status", "ts"}."""
    now = now or time.time()
    h = {k.lower(): v for k, v in (headers or {}).items()}
    out = {"ts": now, "status": h.get("anthropic-ratelimit-unified-status"), "windows": {},
           "overage": h.get("anthropic-ratelimit-unified-overage-status")}
    for w in WINDOWS:
        u = h.get(f"anthropic-ratelimit-unified-{w}-utilization")
        r = h.get(f"anthropic-ratelimit-unified-{w}-reset")
        if u is None:
            continue
        try:
            out["windows"][w] = {"utilization": float(u), "reset": float(r) if r else None,
                                 "status": h.get(f"anthropic-ratelimit-unified-{w}-status")}
        except ValueError:
            continue
    return out


def window_lambda(util: float, reset: float, length: float, now: float, base: float, min_elapsed: float) -> float:
    """λ for one plan window. `proj` = use projected at the reset at the current pace (1.0 = exactly used up)."""
    if util is None:
        return base
    if util >= EXHAUSTED_AT:
        return float("inf")
    elapsed = 1.0 - max(0.0, (reset - now)) / length if reset else 0.5
    proj = util / max(elapsed, min_elapsed)
    if proj <= 0.8:   # allowance will be left over at the reset: nearly free
        return base * proj / 0.8
    if proj <= 1.0:   # on pace: base -> list price
        return base + (proj - 0.8) / 0.2 * (1.0 - base)
    return min(5.0, 1.0 + (proj - 1.0) * 4.0)  # running out before the reset: protect it


def claude_state(snapshot: dict, now: float = None, base: float = None, cfg: dict = None) -> dict:
    """{"lambda", "exhausted", "until", "windows": {w: {"lambda", "utilization", "reset"}}} from the last snapshot."""
    now = now or time.time()
    cfg = cfg or {}
    base = DEFAULT_BASE["window_quota"] if base is None else base
    min_el = {"5h": float(cfg.get("min_elapsed_5h", 0.15)), "7d": float(cfg.get("min_elapsed_7d", 0.05))}
    out = {"lambda": base, "exhausted": False, "until": None, "windows": {}, "known": False}
    wins = (snapshot or {}).get("windows") or {}
    lams = []
    for w, length in WINDOWS.items():
        d = wins.get(w)
        if not d:
            continue
        reset = d.get("reset")
        util = d.get("utilization")
        if reset and reset < now:  # that window has reset since the snapshot
            util = 0.0
        lam = window_lambda(util, reset, length, now, base, min_el[w])
        out["windows"][w] = {"lambda": lam, "utilization": util, "reset": reset}
        lams.append(lam)
        if lam == float("inf"):
            out["exhausted"] = True
            out["until"] = max(out["until"] or 0, reset or now + 3600)
    # A "rejected" answer blocks only the window(s) that themselves said rejected; the overall status alone is trusted only when the
    # snapshot knows no windows. Otherwise a 5 h window that already reset would keep the plan "exhausted" until the 7 d reset, and
    # since nothing is sent to Anthropic while exhausted the snapshot would never refresh (incident 2026-11-02, docs/INCIDENTS.md).
    if not out["exhausted"]:
        blocked = [w.get("reset") for name, w in out["windows"].items()
                   if (wins.get(name) or {}).get("status") == "rejected" and w.get("reset") and w["reset"] > now]
        if blocked:
            out["exhausted"], out["until"] = True, max(blocked)
        elif (snapshot or {}).get("status") == "rejected" and not any((wins.get(n) or {}).get("status") for n in out["windows"]):
            rs = [w.get("reset") for w in out["windows"].values() if w.get("reset") and w["reset"] > now]
            out["exhausted"], out["until"] = True, (min(rs) if rs else now + 3600)
    if lams:
        out["known"] = True
        out["lambda"] = max(lams)
    # Past the plan limit Anthropic may still serve the request as paid "extra usage" (overage-status: allowed). That is real
    # money at API prices, so the plan counts as exhausted unless the person allowed overage; then it is a pay-as-you-go source.
    out["overage"] = (snapshot or {}).get("overage") == "allowed"
    if out["exhausted"] and out["overage"] and cfg.get("allow_overage"):
        out.update(exhausted=False, paying=True, **{"lambda": float(cfg.get("overage_lambda", 1.0))})
    return out


# ------------------------------------------------------------------ Google credits (lots), prepayment, card
class Ledger:
    """Money our gateway spent per source since the config's `since` date (USD), so credit lots can be drawn down oldest-first."""

    def __init__(self, path: str):
        self.path = path
        self.data = {"spent": {}, "days": {}}
        try:
            with open(path) as f:
                self.data.update(json.load(f))
        except (OSError, ValueError):
            pass

    def add(self, source: str, usd: float, now: float = None):
        if usd <= 0:
            return
        day = datetime.fromtimestamp(now or time.time(), timezone.utc).strftime("%Y-%m-%d")
        self.data["spent"][source] = round(self.data["spent"].get(source, 0.0) + usd, 6)
        days = self.data["days"].setdefault(source, {})
        days[day] = round(days.get(day, 0.0) + usd, 6)
        for old in sorted(days)[:-60]:  # keep 60 days of daily totals
            days.pop(old)
        self.save()

    def spent(self, source: str) -> float:
        return float(self.data["spent"].get(source, 0.0))

    def daily_rate(self, source: str, now: float = None, days: int = 14) -> float:
        now = now or time.time()
        d = self.data["days"].get(source) or {}
        cutoff = datetime.fromtimestamp(now - days * 86400, timezone.utc).strftime("%Y-%m-%d")
        return sum(v for k, v in d.items() if k > cutoff) / float(days)

    def save(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f)
        os.replace(tmp, self.path)


def _usd(amount, currency: str, rates: dict) -> float:
    cur = (currency or "USD").upper()
    if cur == "USD":
        return float(amount)
    rate = float(rates.get(cur) or 0)
    if rate <= 0:
        raise ValueError(f"funding: no exchange rate for {cur} (set rates.{cur}: <units per USD>)")
    return float(amount) / rate


def credit_state(src: dict, spent_usd: float, daily_usd: float, now: float = None, rates: dict = None, base: dict = None) -> dict:
    """State of a money source: credit lots first (oldest end date first), then the prepayment, then the card.
    Returns {"lambda", "kind", "remaining_usd", "lot_ends", "exhausted"}."""
    now = now or time.time()
    rates = rates or {}
    base = dict(DEFAULT_BASE, **(base or {}))
    left = spent_usd
    lots = []
    for lot in sorted(src.get("lots") or [], key=lambda x: _ts(x["ends"])):
        ends = _ts(lot["ends"])
        if ends < now:
            continue
        amount = _usd(lot["remaining"], lot.get("currency", src.get("currency", "USD")), rates)
        use = min(amount, left)
        left -= use
        if amount - use > 1e-9:
            lots.append({"remaining": amount - use, "ends": ends})
    prepaid = src.get("prepaid")
    pre_left = 0.0
    if prepaid:
        pre_left = max(0.0, _usd(prepaid["amount"], prepaid.get("currency", src.get("currency", "USD")), rates) - left)
    if lots:
        lot = lots[0]
        days = max(1.0, (lot["ends"] - now) / 86400.0)
        needed = lot["remaining"] / days
        lam = base["expiring_credit"]
        # Only inside the horizon before the end date does unspent credit count as (partly) free money: months ahead, "not spent
        # yet" says nothing, and pricing it at 0 would pull everything to this source before the plan that resets sooner.
        if days <= float(src.get("horizon_days", 30)):
            leftover = max(0.0, lot["remaining"] - daily_usd * days)
            lam = base["expiring_credit"] * (1.0 - leftover / lot["remaining"])
        return {"lambda": lam, "kind": "expiring_credit", "remaining_usd": sum(x["remaining"] for x in lots) + pre_left,
                "lot_ends": lot["ends"], "lot_remaining_usd": lot["remaining"], "needed_per_day_usd": needed, "exhausted": False}
    if pre_left > 1e-9:
        return {"lambda": base["prepaid_balance"], "kind": "prepaid_balance", "remaining_usd": pre_left, "lot_ends": None,
                "exhausted": False}
    if src.get("allow_payg"):
        return {"lambda": base["payg"], "kind": "payg", "remaining_usd": None, "lot_ends": None, "exhausted": False}
    return {"lambda": float("inf"), "kind": "none", "remaining_usd": 0.0, "lot_ends": None, "exhausted": True}
