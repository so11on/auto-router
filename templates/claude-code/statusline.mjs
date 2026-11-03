#!/usr/bin/env node
// Claude Code status line: "sonnet (medium) · ctx 31% · 5h 42%".
// The model and effort come from what Claude Code says it uses; with the auto-router gateway running, from what it REALLY sent
// (and, in shadow mode, what `auto` would have chosen). No tokens are spent: this runs outside the conversation.
import fs from "node:fs";

const FAMILY = (s) => { s = String(s || ""); for (const f of ["haiku", "sonnet", "opus"]) if (s.toLowerCase().includes(f)) return f; return s || "?"; };
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
let model = FAMILY((input.model && (input.model.id || input.model.display_name)) || ""), effort = input.effort && input.effort.level;
let extra = "", plan = "";
try {
  const port = process.env.AR_GATEWAY_PORT || "4001";
  const r = await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(400) });
  const st = await r.json();
  const s = (st.sessions || {})[input.session_id];
  if (s && s.sent && s.sent.model) {
    model = s.sent.model; effort = s.sent.effort || effort;
    if (st.mode === "shadow" && s.model && FAMILY(s.model) !== model) extra = ` · auto: ${FAMILY(s.model)}${s.effort ? ` (${s.effort})` : ""}`;
    else if (st.mode === "shadow" && s.model && s.effort && s.effort !== effort) extra = ` · auto: ${FAMILY(s.model)} (${s.effort})`;
  }
  const w = st.claude && st.claude.windows;
  if (w && w["5h"] && w["5h"].utilization != null) plan = ` · 5h ${Math.round(w["5h"].utilization * 100)}%`;
  if (st.claude && st.claude.exhausted) plan += " · plan out";
} catch {}
const ctx = input.context_window && input.context_window.used_percentage;
console.log(`${model}${effort ? ` (${effort})` : ""}${extra}${ctx != null ? ` · ctx ${Math.round(ctx)}%` : ""}${plan}`);
