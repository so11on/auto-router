// RT-09: learning from use. Run: node --test tests/tune.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { propose, applyProposals, tally, parseAliases, findCell, aliasOf, splitItems } from "../scripts/tune.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const routingText = fs.readFileSync(path.join(ROOT, "litellm", "routing.yaml"), "utf8");
const modelsText = fs.readFileSync(path.join(ROOT, "litellm", "models.yaml"), "utf8");
const aliases = parseAliases(routingText);

const uses = (n, model, extra = {}) => Array.from({ length: n }, (_, i) => ({ type: "route", rid: `${model}${i}${extra.tag || ""}`, session: `${model}-${i}`, mode: "balanced", task: "codegen", band: "c3", model, source: "llm", ts: 1, ...extra }));

test("aliases, cells and list items are read from the real routing.yaml", () => {
  assert.equal(aliasOf("claude-sonnet-cli", aliases), "sn");
  assert.equal(aliasOf("gemini-flash", aliases), "gf");
  assert.equal(aliasOf("unknown-model", aliases), null);
  const cell = findCell(routingText.split("\n"), "balanced", "codegen", "c3");
  assert.deepEqual(cell.items.map((x) => x.replace(/\{model: (\w+).*/, "$1")), ["dsf", "gf", "sn"]);
  assert.deepEqual(splitItems("a, {model: b, effort: {4: x, 5: y}}, c"), ["a", "{model: b, effort: {4: x, 5: y}}", "c"]);
});

test("a model that fails more than 30% of 20+ uses moves one place down; fewer uses change nothing", () => {
  const rows = [...uses(20, "gemini-flash")];
  // 8 of them escalated after tool errors (a switch event in the same session)
  for (let i = 0; i < 8; i++) rows.push({ type: "switch", session: `gemini-flash-${i}`, reason: "tool errors", ts: 2 });
  const t = tally(rows, aliases).get("balanced|codegen|c3|gf");
  assert.deepEqual(t, { uses: 20, failures: 8 });
  const p = propose({ rows, routingText, modelsText });
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].alias, p[0].move], ["gf", "down"]);
  assert.deepEqual(propose({ rows: rows.slice(0, 10), routingText, modelsText }), []);
  const edited = applyProposals(routingText, p);
  assert.deepEqual(findCell(edited.split("\n"), "balanced", "codegen", "c3").items.map((x) => x.replace(/\{model: (\w+).*/, "$1")), ["dsf", "sn", "gf"]);
});

test("a cheaper reliable model moves up, never above its price, never when moved this week, never if unsafe under safety", () => {
  const rows = uses(25, "gemini-flash");  // gf sits second, above sn (a subscription priced like the API); dsf is the first and cheaper than gf
  assert.deepEqual(propose({ rows, routingText, modelsText }), [], "gf is dearer than dsf above it: no promotion");
  const up = uses(25, "deepseek-flash", { task: "codegen", band: "c1-2" });  // first in its cell already
  assert.deepEqual(propose({ rows: up, routingText, modelsText }), []);
  const fl = uses(25, "gemini-flash-lite", { task: "codegen", band: "c1-2" });  // c1-2: [dsf, hk, fl]; fl (0.30+2.50) is dearer than hk (0.10+0.50) above it
  assert.deepEqual(propose({ rows: fl, routingText, modelsText }), []);
  const sn = uses(25, "claude-sonnet-cli");  // c3: [dsf, gf, sn]; sn (2+10) is dearer than gf (0.75+3.75)
  assert.deepEqual(propose({ rows: sn, routingText, modelsText }), []);
  const hkRows = uses(25, "claude-haiku-api", { task: "qa", band: "c1-2" });  // qa c1-2: [fl, dsf, hk]; hk is the cheapest of all and sits last
  const p = propose({ rows: hkRows, routingText, modelsText });
  assert.equal(p.length, 1); assert.deepEqual([p[0].alias, p[0].move], ["hk", "up"]);
  assert.deepEqual(propose({ rows: hkRows, routingText, modelsText, state: { [p[0].key]: Date.now() / 1000 - 86400 }, now: Date.now() / 1000 }), [], "one move per cell per week");
});
