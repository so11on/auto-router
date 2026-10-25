"""Mid-task switching helpers: failure signals, checkpoint timing and downgrade hysteresis.

Which model serves a request is decided by engine.route() from the tables in routing.yaml. This module only decides WHEN a running
task may be re-evaluated and whether a move to a weaker / cheaper model is allowed yet:
  - up immediately on failure signals (consecutive tool errors, a tool-call loop) or a harder classification;
  - down only after `downgrade_confirmations` checkpoints in a row agree and `min_steps_between_switches` steps passed.
A new user message is re-evaluated freely in both directions.
"""
import json
import re

ERROR_RE = re.compile(r"(error|exception|traceback|failed|failure|not found|exit code [1-9]|command failed|cannot|denied)", re.I)

DEFAULT_SWITCHING = {"checkpoint_every": 4, "min_steps_between_switches": 3, "downgrade_confirmations": 2}


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


def failing(sig: dict) -> bool:
    return sig["consecutive_errors"] >= 2 or bool(sig["loop"])


def downgrade_allowed(state: dict, sig: dict, new_user_turn: bool, cfg: dict) -> bool:
    """Count one more vote for a cheaper / weaker model and say whether the move may happen now."""
    if new_user_turn:
        state["down_votes"] = 0
        return True
    state["down_votes"] = state.get("down_votes", 0) + 1
    if state["down_votes"] >= cfg["downgrade_confirmations"] and state.get("steps_since_switch", 0) >= cfg["min_steps_between_switches"]:
        state["down_votes"] = 0
        return True
    return False
