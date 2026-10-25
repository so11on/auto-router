// Learning from use (routing v3, 6.9). Pure functions over data/router.jsonl and the text of routing.yaml / models.yaml.
//   rows -> per (profile, task, band, model) uses and failures -> proposals -> optional edit of routing.yaml
// A "failure" is any of: the task escalated after tool errors / a tool-call loop, a streaming answer had to continue on another model,
// or the user pinned another model right after the answer. Rule: with >= MIN_USES uses of a model in a cell,
//   failure rate > 30%  -> move it one place DOWN in that cell;
//   failure rate < 10%  -> move it one place UP when it is cheaper than the model above it.
// At most one move per cell per week, and a model the safety settings would remove is never promoted.

export const MIN_USES = 20;
export const WEEK = 7 * 86400;
const FAIL_REASONS = new Set(["tool errors", "tool-call loop"]);

/** Concrete model name (claude-sonnet-cli) -> alias used in the tables (sn). */
export function aliasOf(model, aliases) {
  for (const [alias, target] of Object.entries(aliases)) {
    if (model === target || (model.startsWith(target + "-") && /-(cli|api)$/.test(model) && model.length === target.length + 4)) return alias;
  }
  return null;
}

export function parseAliases(routingText) {
  const m = routingText.match(/^aliases:\n((?:  .*\n?)+)/m);
  const out = {};
  if (m) for (const l of m[1].split("\n")) { const x = l.match(/^  ([\w-]+):\s*([\w.-]+)/); if (x) out[x[1]] = x[2]; }
  return out;
}

export function tally(rows, aliases) {
  const routes = new Map(), lastBySession = new Map(), cells = new Map();
  const cellKey = (r) => `${r.mode}|${r.task}|${r.band}|${aliasOf(r.model, aliases)}`;
  const bump = (key, field) => { const c = cells.get(key) || { uses: 0, failures: 0 }; c[field]++; cells.set(key, c); };
  for (const r of rows) {
    if (r.type === "route" && r.band && r.task && r.task !== "pinned" && r.source !== "pinned" && aliasOf(r.model, aliases)) {
      bump(cellKey(r), "uses");
      routes.set(r.rid, r);
      lastBySession.set(r.session, r);
    } else if (r.type === "route" && r.source === "pinned") {
      const prev = lastBySession.get(r.session);
      if (prev && aliasOf(prev.model, aliases)) bump(cellKey(prev), "failures");
    } else if (r.type === "switch" && FAIL_REASONS.has(r.reason)) {
      const prev = lastBySession.get(r.session);
      if (prev && aliasOf(prev.model, aliases)) bump(cellKey(prev), "failures");
    } else if (r.type === "stream_failover" && routes.has(r.rid)) {
      bump(cellKey(routes.get(r.rid)), "failures");
    }
  }
  return cells;
}

/** Items of a flow list `[a, {model: b, effort: x}, c]` split at top-level commas. */
export function splitItems(inner) {
  const out = []; let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const itemAlias = (it) => (it.startsWith("{") ? (it.match(/model:\s*([\w-]+)/) || [])[1] : it);

/** Find a cell `routes.<profile>.<task>.<band>` in the text: { lineIndex, items } */
export function findCell(lines, profile, task, band) {
  let inRoutes = false, p = null, tk = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^routes:/.test(l)) { inRoutes = true; continue; }
    if (inRoutes && /^[A-Za-z_]/.test(l)) break;
    if (!inRoutes) continue;
    let m;
    if ((m = l.match(/^  ([\w-]+):\s*$/))) { p = m[1]; tk = null; continue; }
    if ((m = l.match(/^    ([\w-]+):\s*$/))) { tk = m[1]; continue; }
    if (p === profile && tk === task && (m = l.match(/^      ([\w-]+):\s*\[(.*)\]\s*$/)) && m[1] === band) return { lineIndex: i, items: splitItems(m[2]) };
  }
  return null;
}

/** Price of a request for ranking only: in + out per 1M from models.yaml text; free models (no price) cost 0. */
export function priceOf(modelsText, name) {
  const m = modelsText.match(new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\{[\\s\\S]*?\\}\\n(?=  [\\w-]+: \\{|\\n|$)`, "m"));
  if (!m) return null;
  const p = m[0].match(/price: \{in: ([\d.]+), out: ([\d.]+)/);
  return p ? Number(p[1]) + Number(p[2]) : 0;
}
export function privacyOf(modelsText, name) {
  const m = modelsText.match(new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\{[\\s\\S]*?privacy: (\\w+)`, "m"));
  return m ? m[1] : "unsafe";
}
const concrete = (alias, aliases) => { const t = aliases[alias] || alias; return /^(claude|gpt)-/.test(t) && !/-(cli|api)$/.test(t) ? t + "-cli" : t; };

/** state: { "<cell>|<alias>": lastAppliedEpochSeconds } */
export function propose({ rows, routingText, modelsText, safetyOn = true, state = {}, now = Date.now() / 1000 }) {
  const aliases = parseAliases(routingText), lines = routingText.split("\n"), out = [];
  for (const [key, c] of tally(rows, aliases)) {
    if (c.uses < MIN_USES) continue;
    const [profile, task, band, alias] = key.split("|");
    const cell = findCell(lines, profile, task, band);
    if (!cell) continue;
    const idx = cell.items.findIndex((it) => itemAlias(it) === alias);
    if (idx < 0) continue;
    const rate = c.failures / c.uses;
    if (now - (state[key] || 0) < WEEK) continue;
    if (rate > 0.3 && idx < cell.items.length - 1) out.push({ key, profile, task, band, alias, rate, uses: c.uses, move: "down", from: idx, to: idx + 1 });
    else if (rate < 0.1 && idx > 0) {
      const above = itemAlias(cell.items[idx - 1]);
      const mine = concrete(alias, aliases), other = concrete(above, aliases);
      if (safetyOn && privacyOf(modelsText, mine) === "unsafe") continue;  // never promote what the safety filter would remove
      const pm = priceOf(modelsText, mine), po = priceOf(modelsText, other);
      if (pm !== null && po !== null && pm < po) out.push({ key, profile, task, band, alias, rate, uses: c.uses, move: "up", from: idx, to: idx - 1 });
    }
  }
  return out;
}

export function applyProposals(routingText, proposals) {
  const lines = routingText.split("\n");
  for (const p of proposals) {
    const cell = findCell(lines, p.profile, p.task, p.band);
    if (!cell) continue;
    const items = cell.items;
    [items[p.from], items[p.to]] = [items[p.to], items[p.from]];
    lines[cell.lineIndex] = lines[cell.lineIndex].replace(/\[.*\]\s*$/, `[${items.join(", ")}]`);
  }
  return lines.join("\n");
}
