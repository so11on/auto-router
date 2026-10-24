"""Model choice inside a profile: complexity table + mid-task checkpoints + hysteresis + quota/context adjustments.

The profile's table in routing.yaml is the guideline: it lists, from cheapest to strongest, the only models the profile
may use (its floor and ceiling). Within a task the model can move up or down that table:
  - up immediately on failure signals (consecutive tool errors, a tool-call loop) or a higher classified complexity;
  - down only after `downgrade_confirmations` checkpoints in a row agree and `min_steps_between_switches` steps passed.
New user messages are re-evaluated freely in both directions.
"""
import json
import re

ERROR_RE = re.compile(r"(error|exception|traceback|failed|failure|not found|exit code [1-9]|command failed|cannot|denied)", re.I)

DEFAULT_SWITCHING = {"checkpoint_every": 4, "min_steps_between_switches": 3, "downgrade_confirmations": 2}


def pick(routing: dict, mode: str, task: str, complexity: int) -> dict:
    c = max(1, min(5, complexity + (routing.get("task_bump") or {}).get(task, 0)))
    tiers = routing["modes"][mode]
    for tier in tiers:
        if c <= tier["max_complexity"]:
            return {**tier, "task": task, "complexity": c}
    return {**tiers[-1], "task": task, "complexity": c}


def ladder(routing: dict, mode: str) -> list:
    """Distinct models of the profile, cheapest first (the order they appear in the table)."""
    out = []
    for tier in routing["modes"][mode]:
        if tier["model"] not in out:
            out.append(tier["model"])
    return out


def rank(routing: dict, mode: str, model: str) -> int:
    lad = ladder(routing, mode)
    return lad.index(model) if model in lad else -1


def signals(messages: list) -> dict:
    """Facts about the current task, counted since the last user message."""
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
    tail = messages[last_user + 1:]
    tool_results = [m for m in tail if m.get("role") == "tool"]
    errors = 0
    for m in reversed(tool_results):
        c = m.get("content")
        text = c if isinstance(c, str) else json.dumps(c, default=str)
        if ERROR_RE.search(text[:2000]):
            errors += 1
        else:
            break
    calls = []
    for m in tail:
        for c in m.get("tool_calls") or []:
            f = c.get("function") or {}
            calls.append((f.get("name"), f.get("arguments")))
    loop = len(calls) >= 3 and calls[-1] == calls[-2] == calls[-3]
    return {"steps": len(tool_results), "consecutive_errors": errors, "loop": loop}


def needs_checkpoint(state: dict, sig: dict, cfg: dict) -> bool:
    if sig["consecutive_errors"] >= 2 or sig["loop"]:
        return True
    return sig["steps"] - state.get("last_eval_step", 0) >= cfg["checkpoint_every"]


def decide(routing: dict, mode: str, state: dict, target: dict, sig: dict, new_user_turn: bool, cfg: dict):
    """Apply hysteresis. Returns (decision, reason, switched)."""
    current = state.get("decision")
    if current is None:
        return target, "first decision", True
    cur_rank, tgt_rank = rank(routing, mode, current["model"]), rank(routing, mode, target["model"])
    failing = sig["consecutive_errors"] >= 2 or sig["loop"]
    if failing and tgt_rank <= cur_rank:  # failure signal: go one step up the ladder
        lad = ladder(routing, mode)
        if cur_rank + 1 < len(lad):
            up = next(t for t in routing["modes"][mode] if t["model"] == lad[cur_rank + 1])
            return ({**up, "task": target["task"], "complexity": max(target["complexity"], current["complexity"])},
                    "tool errors" if sig["consecutive_errors"] >= 2 else "tool-call loop", True)
        return current, "already at the profile ceiling", False
    if tgt_rank > cur_rank:
        state["down_votes"] = 0
        return target, "harder next steps", True
    if tgt_rank < cur_rank:
        if new_user_turn:
            state["down_votes"] = 0
            return target, "new request is simpler", True
        state["down_votes"] = state.get("down_votes", 0) + 1
        if (state["down_votes"] >= cfg["downgrade_confirmations"]
                and state.get("steps_since_switch", 0) >= cfg["min_steps_between_switches"]):
            state["down_votes"] = 0
            return target, "simpler next steps", True
        return current, f"downgrade pending ({state['down_votes']}/{cfg['downgrade_confirmations']})", False
    state["down_votes"] = 0
    if target.get("effort") != current.get("effort"):
        return target, "effort adjusted", False
    return current, "unchanged", False


def adjust(routing: dict, mode: str, decision: dict, health, fits, resolve):
    """Swap to another model of the same profile if the chosen one is out of quota or cannot hold the context.

    health(name) -> state string, fits(name) -> bool, resolve(name) -> concrete model_name (claude-* -> -cli/-api).
    Preference: the chosen model, then stronger ones (closest first), then cheaper ones."""
    lad = ladder(routing, mode)
    model = decision["model"]
    if model not in lad:
        return decision, None
    i = lad.index(model)
    order = [model] + lad[i + 1:] + list(reversed(lad[:i]))
    for cand in order:
        concrete = resolve(cand)
        if health(concrete) in ("critical", "exhausted") or not fits(concrete):
            continue
        if cand == model:
            return decision, None
        tier = next(t for t in routing["modes"][mode] if t["model"] == cand)
        why = "quota" if health(resolve(model)) in ("critical", "exhausted") else "context"
        return {**tier, "task": decision["task"], "complexity": decision["complexity"]}, f"{model} skipped ({why})"
    return decision, "no healthy alternative; keeping choice"
