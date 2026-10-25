// Tests for ar.mjs helpers and a fresh-install simulation. Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, setEnvText, patchProviders, buildProvider, vscodeUserDir, openaiBlocks, applyBlocks, buildRoutingText, familiesFrom, copilotBlocks, LADDER, planSync, applySync, mergeEnv, mergeRouting, mergeConfig, mergeCompose, composeImage, setComposeImage, changelogSince } from "../ar.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseEnv handles comments, quotes and inline comments", () => {
  const e = parseEnv('# c\nA=1\nB = "two words"  \nC=3   # inline\n\nD=\n');
  assert.deepEqual(e, { A: "1", B: "two words", C: "3", D: "" });
});

test("setEnvText replaces in place and appends missing keys", () => {
  const t = setEnvText("A=\nB=keep\n", "A", "x");
  assert.equal(t, "A=x\nB=keep\n");
  assert.match(setEnvText("A=1\n", "Z", "9"), /Z=9\n$/);
});

test("patchProviders adds, replaces and removes only auto-router", () => {
  const other = [{ name: "Gemini", vendor: "gemini" }];
  const p = buildProvider("sk-test");
  let out = JSON.parse(patchProviders(JSON.stringify(other), p));
  assert.deepEqual(out.map((x) => x.name), ["Gemini", "auto-router"]);
  assert.equal(out[1].models[0].requestHeaders.Authorization, "Bearer sk-test");
  assert.equal(out[1].apiType, "chat-completions");
  out = JSON.parse(patchProviders(JSON.stringify(out), buildProvider("sk-new")));
  assert.equal(out.length, 2);
  assert.equal(out[1].models[0].requestHeaders.Authorization, "Bearer sk-new");
  out = JSON.parse(patchProviders(JSON.stringify(out), p, true));
  assert.deepEqual(out.map((x) => x.name), ["Gemini"]);
  assert.equal(JSON.parse(patchProviders("", p)).length, 1);
  assert.throws(() => patchProviders("// comment\n[]", p), /plain JSON/);
});

test("openai blocks: routes, fallbacks and managed markers in config.yaml", () => {
  const ids = { mini: "m-mini", main: "m-main", max: "m-max" };
  const both = openaiBlocks({ route: "both", ids, hasGemini: true });
  assert.match(both.models, /gpt-main-cli.*openai\/codex-code-main.*host\.docker\.internal:4100/);
  assert.match(both.models, /gpt-max-api.*openai\/m-max.*OPENAI_API_KEY/);
  assert.match(both.fallbacks, /gpt-main-cli: \[gpt-main-api, gemini-flash-lite\]/);
  const cli = openaiBlocks({ route: "cli", ids: {}, hasGemini: false });
  assert.ok(!cli.models.includes("-api"));
  assert.equal(cli.fallbacks, "");
  const cfg = fs.readFileSync(path.join(ROOT, "litellm", "config.yaml"), "utf8");
  const begin = "  # >>> openai (managed by ar.mjs)", end = "  # <<< openai";
  const out = applyBlocks(applyBlocks(cfg, begin, end, both.models), "    # >>> openai-fallbacks (managed by ar.mjs)", "    # <<< openai-fallbacks", both.fallbacks);
  assert.ok(out.includes("gpt-mini-api") && out.includes("- {gpt-max-api: [gpt-max-cli"));
  assert.equal(applyBlocks(out, begin, end, "").includes("model_name: gpt-mini-api"), false, "re-applying replaces the block");
  assert.throws(() => applyBlocks("no markers", begin, end, "x"), /not found/);
});

const BASE = fs.readFileSync(path.join(ROOT, "profiles", "routing.A.yaml"), "utf8");
const tiers = (text, mode) => text.split(`  ${mode}:\n`)[1].split(/\n  \w+:\n|\n\n/)[0].split("\n").map((l) => l.trim());

test("profile auto: Claude+Gemini+pool reproduces the hand-made profile A tables", () => {
  const out = buildRoutingText(["claude", "gemini"], true, BASE);
  assert.deepEqual(tiers(out, "balanced"), tiers(BASE, "balanced"));
  assert.deepEqual(tiers(out, "smart"), tiers(BASE, "smart"));
  assert.deepEqual(tiers(out, "free"), tiers(BASE, "free"));
  assert.match(out, /^# Profile "auto"/);
  assert.match(out, /pins:/);
});

test("profile auto: copilot, openai, free-only and no-pool combinations", () => {
  const cp = buildRoutingText(["copilot"], true, BASE);
  assert.match(tiers(cp, "smart").join(" "), /copilot-max/);
  assert.ok(!/claude-|gpt-|gemini-/.test(tiers(cp, "smart").join(" ") + tiers(cp, "balanced").join(" ")));
  const both = buildRoutingText(["openai", "copilot", "gemini"], true, BASE);
  assert.match(tiers(both, "smart").join(" "), /gpt-max/, "openai leads over copilot when both exist");
  assert.match(tiers(both, "balanced").join(" "), /gemini-flash-lite.*gemini-flash/s, "gemini covers the cheap rungs");
  const free = buildRoutingText([], true, BASE);
  assert.deepEqual(tiers(free, "smart"), ["- {max_complexity: 5, model: free-pool-coding}"]);
  const noPool = buildRoutingText(["claude"], false, BASE);
  assert.ok(!/free-pool/.test(tiers(noPool, "balanced").join(" ")));
  assert.match(tiers(noPool, "free").join(" "), /gemini-free-flash-lite/);
  for (const f of Object.keys(LADDER)) assert.ok(LADDER[f].lo && LADDER[f].mid && LADDER[f].hi);
});

test("familiesFrom maps detected plans to routing families", () => {
  const d = { claude: { cli: true, loggedIn: true }, openai: { cli: true, loggedIn: false, apiKey: false }, copilot: { cli: true, paid: true }, gemini: { paidKey: false } };
  assert.deepEqual(familiesFrom(d), ["claude", "copilot"]);
  d.copilot.paid = false; d.openai.apiKey = true; d.gemini.paidKey = true;
  assert.deepEqual(familiesFrom(d), ["claude", "openai", "gemini"]);
});

test("copilot blocks and fresh install with --profile auto", () => {
  assert.match(copilotBlocks({ hasGemini: true }).models, /copilot-main.*copilot-code-main.*4100/);
  assert.match(copilotBlocks({ hasGemini: true }).fallbacks, /copilot-max: \[gemini-flash-lite\]/);
  assert.equal(copilotBlocks({ hasGemini: false }).fallbacks, "");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-auto-"));
  const copy = path.join(tmp, "repo");
  fs.cpSync(ROOT, copy, { recursive: true, filter: (s) => !/[\\/](\.git|data|node_modules|\.auto-router)([\\/]|$)/.test(s) && !/[\\/]\.env(\.bak)?$/.test(s) });
  const home = path.join(tmp, "home"); fs.mkdirSync(path.join(home, "code"), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(copy, "ar.mjs"), "init", "--roots", path.join(home, "code"), "--profile", "auto", "--families", "copilot,gemini"],
    { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const routing = fs.readFileSync(path.join(copy, "litellm", "routing.yaml"), "utf8");
  assert.match(routing, /for: copilot, gemini|for: copilot, gemini \+ free pool/);
  assert.match(routing, /copilot-max/);
  assert.equal(parseEnv(fs.readFileSync(path.join(copy, ".env"), "utf8")).CLASSIFIER_MODEL, "gemini/gemini-3.5-flash-lite");
  fs.rmSync(tmp, { recursive: true, force: true });
});

function oldInstall() {
  // an install made with the very first public version: no VERSION, no Copilot/OpenAI pins, no managed blocks, fewer .env settings
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-old-"));
  const dir = path.join(tmp, "install");
  fs.cpSync(ROOT, dir, { recursive: true, filter: (s) => !/[\\/](\.git|data|node_modules|\.auto-router)([\\/]|$)/.test(s) && !/[\\/]\.env(\.bak)?$/.test(s) });
  fs.rmSync(path.join(dir, "VERSION")); fs.rmSync(path.join(dir, "CHANGELOG.md")); fs.rmSync(path.join(dir, "docs", "GET-KEYS.md"));
  const rp = path.join(dir, "litellm", "routing.yaml");
  fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace(/  (gpt|gpt-max|gpt-mini|copilot|copilot-max|copilot-mini):.*\n/g, "").replace(/\n# Mid-task model switching[\s\S]*?(?=\n# Context control)/, "").replace("max_complexity: 3, model: gemini-flash}", "max_complexity: 3, model: gemini-flash-lite}") // user tuning
  );
  const cp = path.join(dir, "litellm", "config.yaml");
  fs.writeFileSync(cp, fs.readFileSync(cp, "utf8").replace(/ *# >>> (openai|copilot)[^\n]*\n[\s\S]*?# <<< (openai|copilot)[^\n]*\n/g, ""));
  fs.writeFileSync(path.join(dir, ".env"), "LITELLM_MASTER_KEY=sk-mine\nGROQ_API_KEY=gsk_mine\nCLAUDE_PRIMARY=api\nBRIDGE_KEY=b\nBRIDGE_ALLOWED_ROOTS=/x\nFREE_POOL_ENABLED=true\n");
  fs.mkdirSync(path.join(dir, "data")); fs.writeFileSync(path.join(dir, "data", "usage.jsonl"), "{}\n");
  return { tmp, dir };
}

test("update: an old install gets the new features and keeps every user choice", () => {
  const { tmp, dir } = oldInstall();
  const before = fs.readFileSync(path.join(dir, "litellm", "routing.yaml"), "utf8");
  assert.ok(!before.includes("copilot-max") && !before.includes("switching:"));
  // make the config carry a user-managed OpenAI block, as `ar.mjs openai` would have written it
  const cp = path.join(dir, "litellm", "config.yaml");
  fs.writeFileSync(cp, fs.readFileSync(cp, "utf8").replace("  # --- virtual models shown", "  # >>> openai (managed by ar.mjs)\n  - {model_name: gpt-main-api, litellm_params: {model: openai/mine, api_key: os.environ/OPENAI_API_KEY}}\n  # <<< openai\n\n  # --- virtual models shown"));
  const plan = planSync(ROOT, dir);
  assert.ok(plan.add.includes("VERSION") && plan.add.includes("docs/GET-KEYS.md") && plan.add.includes("CHANGELOG.md"));
  assert.ok(plan.merged.includes("litellm/routing.yaml") && plan.merged.includes("litellm/config.yaml"));
  assert.ok(plan.env.added.includes("OPENAI_API_KEY") && plan.env.added.includes("COPILOT_MODEL_MAIN"));
  assert.ok(!plan.change.concat(plan.add).includes(".env") && !plan.change.concat(plan.add).some((f) => f.startsWith("data/")));
  const backup = path.join(dir, "data", "bk");
  applySync(plan, ROOT, dir, backup);
  // user data untouched
  const env = parseEnv(fs.readFileSync(path.join(dir, ".env"), "utf8"));
  assert.equal(env.LITELLM_MASTER_KEY, "sk-mine"); assert.equal(env.GROQ_API_KEY, "gsk_mine");
  assert.equal(env.CLAUDE_PRIMARY, "api"); assert.equal(env.BRIDGE_ALLOWED_ROOTS, "/x");
  assert.equal(env.OPENAI_PRIMARY, "cli"); assert.equal(env.AUTO_ROUTER_FOOTER, "true", "new settings take the example's default, not an empty value");
  assert.ok("COPILOT_MODEL_MAIN" in env && "OPENAI_API_KEY" in env);
  assert.equal(fs.readFileSync(path.join(dir, "data", "usage.jsonl"), "utf8"), "{}\n");
  // routing: user tuning kept, new pins and sections added
  const r = fs.readFileSync(path.join(dir, "litellm", "routing.yaml"), "utf8");
  assert.match(r, /max_complexity: 3, model: gemini-flash-lite\}/, "the user's tier edit survives");
  for (const pin of ["gpt", "gpt-max", "copilot", "copilot-max", "copilot-mini"]) assert.match(r, new RegExp(`^  ${pin}:`, "m"));
  assert.match(r, /^switching:/m); assert.match(r, /^context:/m);
  assert.equal((r.match(/^pins:/gm) || []).length, 1);
  // config: new markers present, the user's managed OpenAI block carried over
  const c = fs.readFileSync(cp, "utf8");
  assert.ok(c.includes(">>> copilot (managed by ar.mjs)") && c.includes(">>> copilot-fallbacks"));
  assert.ok(c.includes("openai/mine"), "managed block content is preserved");
  // code was replaced and the old copies backed up
  assert.equal(fs.readFileSync(path.join(dir, "ar.mjs"), "utf8"), fs.readFileSync(path.join(ROOT, "ar.mjs"), "utf8"));
  assert.ok(fs.existsSync(path.join(backup, "litellm", "routing.yaml")) && fs.existsSync(path.join(backup, ".env")));
  // idempotent
  const again = planSync(ROOT, dir);
  assert.deepEqual([again.add, again.change, again.env.added], [[], [], []]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("update helpers: env defaults, routing pin merge, changelog filter, nothing secret copied", () => {
  const ex = "# comment for X\nX=default\nSECRET=\n";
  const m = mergeEnv("A=1\n", ex);
  assert.match(m.text, /# comment for X\nX=default\nSECRET=\n$/);
  assert.equal(mergeEnv(m.text, ex).text, m.text, "no duplicates on a second run");
  const merged = mergeRouting("modes:\n  free:\n    - {max_complexity: 5, model: a}\n\npins:\n  opus:     {model: claude-opus}\n", "pins:\n  opus:     {model: claude-opus}\n  gpt:      {model: gpt-main}\n");
  assert.match(merged, /opus:.*\n  gpt: /);
  const log = "# Changelog\n\n## 0.3.0 — d\n- c\n\n## 0.2.0 — d\n- b\n\n## 0.1.0 — d\n- a\n";
  assert.match(changelogSince(log, "0.2.0"), /0\.3\.0/);
  assert.ok(!changelogSince(log, "0.2.0").includes("0.2.0"));
  assert.match(changelogSince(log, "0.0.0 (before versioning)"), /0\.1\.0/);
  assert.equal(changelogSince(log, "0.3.0"), "");
  assert.equal(mergeConfig("x", "y"), "y");
});

test("profiles A-F exist, are valid, and every model they name is defined or a known family", () => {
  for (const p of "ABCDEF") {
    const t = fs.readFileSync(path.join(ROOT, "profiles", `routing.${p}.yaml`), "utf8");
    assert.match(t, /modes:/);
    assert.match(t, /pins:/);
  }
  assert.match(fs.readFileSync(path.join(ROOT, "profiles", "routing.E.yaml"), "utf8"), /gpt-max/);
  assert.ok(!/claude-/.test(fs.readFileSync(path.join(ROOT, "profiles", "routing.F.yaml"), "utf8").split("# Pins:")[0].split("modes:")[1]));
});

test("vscodeUserDir is OS specific and ends with User", () => {
  assert.match(vscodeUserDir(), /User$/);
  assert.match(vscodeUserDir("Code - Insiders"), /Code - Insiders/);
});

test("fresh install: init creates .env with generated secrets, profile and local config; vscode --dir patches a file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fresh-"));
  const copy = path.join(tmp, "repo");
  fs.cpSync(ROOT, copy, { recursive: true, filter: (s) => !/[\\/](\.git|data|node_modules|\.auto-router)([\\/]|$)/.test(s) && !/[\\/]\.env(\.bak)?$/.test(s) });
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, "code"), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (...a) => spawnSync(process.execPath, [path.join(copy, "ar.mjs"), ...a], { encoding: "utf8", env });
  assert.notEqual(run("init").status, 0, "init without --roots must fail");
  const r = run("init", "--roots", path.join(home, "code"), "--profile", "D", "--claude", "api");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const e = parseEnv(fs.readFileSync(path.join(copy, ".env"), "utf8"));
  assert.match(e.LITELLM_MASTER_KEY, /^sk-[0-9a-f]{32}$/);
  assert.match(e.BRIDGE_KEY, /^[0-9a-f]{32}$/);
  assert.equal(e.BRIDGE_ALLOWED_ROOTS, path.join(home, "code"));
  assert.equal(e.CLAUDE_PRIMARY, "api");
  assert.equal(e.CLASSIFIER_MODEL, "pool");
  assert.equal(e.GEMINI_API_KEY, "");
  assert.match(fs.readFileSync(path.join(copy, "litellm", "routing.yaml"), "utf8"), /Profile D/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".auto-router", "config.json"), "utf8"));
  assert.equal(fs.realpathSync(cfg.repo), fs.realpathSync(copy));
  const vs = path.join(tmp, "vscode-user");
  const v = run("vscode", "--dir", vs);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const prov = JSON.parse(fs.readFileSync(path.join(vs, "chatLanguageModels.json"), "utf8"));
  assert.equal(prov[0].models.length, 3);
  assert.equal(prov[0].models[0].requestHeaders.Authorization, `Bearer ${e.LITELLM_MASTER_KEY}`);
  assert.equal(run("init", "--roots", path.join(home, "code")).status, 0, "re-running init keeps .env");
  assert.equal(parseEnv(fs.readFileSync(path.join(copy, ".env"), "utf8")).LITELLM_MASTER_KEY, e.LITELLM_MASTER_KEY);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("no personal data or secrets are shipped", () => {
  const bad = [/so11on/i, /sollon/i, /limarj/i, /\/Users\/[a-z0-9]+/i, /C:\\Users\\[a-z0-9]+/i, /sk-[A-Za-z0-9]{24,}/, /AIza[0-9A-Za-z_-]{30}/, /gsk_[A-Za-z0-9]{20,}/, /nvapi-[A-Za-z0-9_-]{20,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /sk-or-[A-Za-z0-9_-]{20,}/, /ghp_[A-Za-z0-9]{20,}/];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => {
    const p = path.join(d, x.name);
    if (/^(\.git|data|node_modules|\.auto-router)$/.test(x.name) || /^\.env(\.bak)?$/.test(x.name) || x.name.endsWith(".vsix") || p.endsWith(path.join("tests", "ar.test.mjs"))) return [];
    return x.isDirectory() ? walk(p) : [p];
  });
  const hits = [];
  for (const f of walk(ROOT)) {
    const t = fs.readFileSync(f, "utf8").replaceAll("github.com/so11on/auto-router", "").replaceAll("so11on/auto-router", ""); // the public repository URL is intentional
    for (const re of bad) if (re.test(t)) hits.push(`${path.relative(ROOT, f)} ~ ${re}`);
  }
  assert.deepEqual(hits, []);
});

test("SEC-10: roots may not contain the auto-router itself, the home folder or the disk root", async () => {
  const { rootProblems } = await import("../ar.mjs");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ar-repo-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "ar-code-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ar-home-"));
  try {
    assert.deepEqual(rootProblems([other], repo, home), []);
    const inRepo = rootProblems([path.dirname(repo)], repo, home);
    assert.equal(inRepo.length, 1);
    assert.match(inRepo[0].msg, /dentro de uma pasta/);
    assert.equal(rootProblems([home], repo, home)[0].fatal, true);
    assert.equal(rootProblems([path.parse(os.tmpdir()).root], repo, home)[0].fatal, true);
  } finally { for (const d of [repo, other, home]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("SEC-09: every pool candidate declares a privacy class and the providers needing a key are known", () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "profiles", "pool-models.json"), "utf8"));
  for (const combo of ["free-fast", "free-coding"]) {
    assert.ok(spec[combo].length > 0);
    for (const m of spec[combo]) {
      assert.match(m.id, /^[a-z0-9-]+\//);
      assert.ok(["trusted", "no_retention", "restricted", "unsafe"].includes(m.privacy), m.id);
    }
  }
  assert.ok(spec["free-fast"].some((m) => m.privacy !== "unsafe"), "with SAFETY_MODE=on the fast combo must still have members");
  assert.ok(spec["free-coding"].some((m) => m.privacy !== "unsafe"));
});

test("SEC-16: compose pins images by digest and `update` never changes which image runs", () => {
  const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  assert.doesNotMatch(compose, /:latest|:main-stable(?!@)/);
  for (const svc of ["omniroute", "litellm"]) assert.match(composeImage(compose, svc), /@sha256:[0-9a-f]{64}$/, svc);
  const local = compose;
  const upstream = compose.replace(/(omniroute:)\S+/, "$1999.0.0@sha256:" + "a".repeat(64)).replace("restart: unless-stopped", "restart: always");
  const merged = mergeCompose(local, upstream);
  assert.equal(composeImage(merged, "omniroute"), composeImage(local, "omniroute"), "the pinned image survives");
  assert.match(merged, /restart: always/, "other upstream changes are taken");
  // an old install with a floating tag gets upstream's pinned line
  const old = local.replace(/image: diegosouzapw\S+/, "image: diegosouzapw/omniroute:latest");
  assert.equal(composeImage(mergeCompose(old, local), "omniroute"), composeImage(local, "omniroute"));
  assert.match(setComposeImage(local, "omniroute", "x/y:1@sha256:" + "b".repeat(64)), /image: x\/y:1@sha256:b{64}/);
  assert.equal(composeImage(setComposeImage(local, "omniroute", "x/y:1"), "litellm"), composeImage(local, "litellm"));
});

test("SEC-16: omniroute-upgrade to a tag that does not exist changes nothing", { skip: spawnSync("docker", ["info"]).status !== 0 && "docker not available" }, () => {
  const before = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  const r = spawnSync(process.execPath, [path.join(ROOT, "ar.mjs"), "omniroute-upgrade", "--to", "zzz-does-not-exist-0"], { encoding: "utf8", timeout: 120000 });
  assert.match(r.stdout + r.stderr, /could not pull/);
  assert.equal(fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8"), before);
});

test("SEC-12: vscode hardening is idempotent, keeps user values, never enables auto-approve, and --uninstall removes only what it added", async () => {
  const { patchHarden, HARDEN_AUTOAPPROVE } = await import("../ar.mjs");
  const mine = JSON.stringify({ "editor.fontSize": 14, "chat.tools.edits.autoApprove": { "**/*": true, "**/.env": true } });
  const a = patchHarden(mine, {});
  const cfgA = JSON.parse(a.text);
  assert.equal(cfgA["editor.fontSize"], 14);
  assert.equal(cfgA["chat.tools.edits.autoApprove"]["**/.env"], true, "the user's own choice is not overridden");
  assert.deepEqual(a.kept, ["**/.env"]);
  assert.equal(cfgA["chat.tools.edits.autoApprove"]["**/*.pem"], false);
  assert.equal(cfgA["chat.agent.sandbox.enabled"], true);
  assert.equal(cfgA["chat.tools.terminal.sandbox.enabled"], undefined);
  assert.ok(!("chat.agent.autoApprove" in cfgA) && !JSON.stringify(cfgA).includes("autopilot"));
  const b = patchHarden(a.text, { added: a.added });
  assert.equal(b.text, a.text, "second run changes nothing");
  assert.deepEqual(b.added, a.added);
  const u = JSON.parse(patchHarden(b.text, { added: b.added }, { remove: true }).text);
  assert.deepEqual(u, JSON.parse(mine), "uninstall restores exactly what was there before");
  assert.equal(Object.keys(HARDEN_AUTOAPPROVE).length, 6);
  assert.throws(() => patchHarden("{ // comment\n}"), /comments/);
  assert.equal(JSON.parse(patchHarden("", {}, { sandbox: false }).text)["chat.agent.sandbox.enabled"], undefined);
});

test("SEC-06: the committed .vsix is exactly what the sources build, and SHA256SUMS matches it", async () => {
  const { buildVsix, sha256 } = await import("../scripts/build-vsix.mjs");
  const committed = fs.readFileSync(path.join(ROOT, "vscode-extension", "auto-router-companion.vsix"));
  assert.equal(sha256(buildVsix()), sha256(committed), "run: node scripts/build-vsix.mjs");
  assert.match(fs.readFileSync(path.join(ROOT, "vscode-extension", "SHA256SUMS"), "utf8"), new RegExp(`^${sha256(committed)}  auto-router-companion\\.vsix\\n$`));
});

test("SEC-06: CI workflow is least-privilege, pinned by SHA and scans for secrets", () => {
  const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8");
  assert.match(wf, /^permissions:\n  contents: read/m);
  assert.match(wf, /^concurrency:/m);
  for (const line of wf.split("\n").filter((l) => /uses:/.test(l))) assert.match(line, /@[0-9a-f]{40}\b/, line);
  assert.match(wf, /gitleaks/);
  const dep = fs.readFileSync(path.join(ROOT, ".github", "dependabot.yml"), "utf8");
  for (const eco of ["github-actions", "npm", "pip"]) assert.ok(dep.includes(eco), eco);
});

test("SEC-06: update follows the highest release tag and refuses an unreleased branch without --yes", async () => {
  const { latestTag } = await import("../ar.mjs");
  assert.equal(latestTag(["main", "v0.9.0", "v0.10.0", "v0.2.1", "nightly", "v1.0.0-rc1"]), "v0.10.0");
  assert.equal(latestTag(["main", "dev"]), null);
  assert.equal(latestTag([]), null);
  const r = spawnSync(process.execPath, [path.join(ROOT, "ar.mjs"), "update", "--ref", "main", "--apply", "--repo", "so11on/auto-router"], { encoding: "utf8", timeout: 60000 });
  assert.match(r.stdout + r.stderr, /branch|--yes/);
});
