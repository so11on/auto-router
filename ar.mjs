#!/usr/bin/env node
// auto-router control script. Node >= 18, no dependencies, works on Windows, macOS and Linux.
//
//   node ar.mjs doctor                  check Docker / Node / Claude CLI / VS Code and ports
//   node ar.mjs init [options]          create .env (generated secrets), pick a routing profile, remember paths
//   node ar.mjs keys [--check]          which keys are set (names only); --check also asks each provider whether the key works
//   node ar.mjs cloudflare-token       mint a Workers-AI-only token from a token that can only create tokens (see docs/GET-KEYS.md)
//   node ar.mjs detect [--json]        which paid plans / logins this computer has (Claude, ChatGPT, GitHub Copilot, keys)
//   node ar.mjs copilot [options]       configure your paid GitHub Copilot plan as router targets (Copilot CLI)
//   node ar.mjs openai [options]        configure OpenAI: Codex CLI with your ChatGPT login and/or an OpenAI API key
//   node ar.mjs up | down | status      start / stop / inspect the whole stack
//   node ar.mjs omniroute               connect the free providers whose keys are in .env, verify models, build the combos
//   node ar.mjs vscode [--uninstall]    add the Auto: models to VS Code and install the companion extension
//   node ar.mjs smoke                   one real request per profile
//   node ar.mjs logs [-f] [--errors] [--tail N] [--type T]     operation log
//   node ar.mjs usage [--since 24h|7d|all] [--by model|mode]   token / usage report and quota forecast
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, "data");
const ENV_FILE = path.join(ROOT, ".env");
const HOME_CFG_DIR = path.join(os.homedir(), ".auto-router");
const IS_WIN = process.platform === "win32";
const GATEWAY = "http://127.0.0.1:4000";
const OMNI = "http://127.0.0.1:20128";
const BRIDGE = "http://127.0.0.1:4100";

const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const ok = (s) => console.log(`${c(32, "✔")} ${s}`);
const bad = (s) => console.log(`${c(31, "✘")} ${s}`);
const warn = (s) => console.log(`${c(33, "!")} ${s}`);
const info = (s) => console.log(`  ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("-")) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === "-f") flags.follow = true;
    else rest.push(a);
  }
  return { flags, rest };
}

// ---------------------------------------------------------------- .env
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const q = v.match(/^(["'])(.*)\1/);
    v = q ? q[2] : v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}
const readEnv = () => { try { return parseEnv(fs.readFileSync(ENV_FILE, "utf8")); } catch { return null; } };

export function setEnvText(text, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*=).*$`, "m");
  if (re.test(text)) return text.replace(re, (_, p) => `${p}${value}`);
  return text.replace(/\s*$/, "\n") + `${key}=${value}\n`;
}
function setEnv(key, value) {
  const t = fs.readFileSync(ENV_FILE, "utf8");
  fs.writeFileSync(ENV_FILE, setEnvText(t, key, value), { mode: 0o600 });
}

// ---------------------------------------------------------------- processes / network
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: IS_WIN && /\.(cmd|bat)$/i.test(cmd), ...opts });
}
function which(name) {
  const r = run(IS_WIN ? "where" : "which", [name]);
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}
function portOpen(port, host = "127.0.0.1") {
  return new Promise((res) => {
    const s = net.connect({ port, host }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(1500, () => { s.destroy(); res(false); });
  });
}
async function http(url, { method = "GET", headers = {}, body, timeout = 30000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json, headers: r.headers };
  } catch (e) { return { status: 0, text: String(e.message || e), json: null, headers: new Headers() }; }
  finally { clearTimeout(t); }
}
const compose = (args, opts = {}) => spawnSync("docker", ["compose", ...args], { cwd: ROOT, stdio: "inherit", ...opts });

// ---------------------------------------------------------------- doctor
async function doctor() {
  let fatal = 0;
  console.log(`auto-router doctor — ${process.platform} ${os.arch()}, Node ${process.version}\n`);
  if (Number(process.versions.node.split(".")[0]) >= 18) ok("Node.js >= 18"); else { bad("Node.js >= 18 required (https://nodejs.org)"); fatal++; }
  const dv = run("docker", ["--version"]);
  if (dv.status === 0) {
    ok(dv.stdout.trim());
    const di = run("docker", ["info"]);
    if (di.status === 0) ok("Docker daemon is running"); else { bad("Docker is installed but not running — start Docker Desktop / the docker service"); fatal++; }
    if (run("docker", ["compose", "version"]).status === 0) ok("docker compose available"); else { bad("`docker compose` (v2) missing — update Docker"); fatal++; }
  } else { bad("Docker not found — install Docker Desktop (Windows/macOS) or Docker Engine + compose plugin (Linux): https://docs.docker.com/get-docker/"); fatal++; }
  const cl = which("claude");
  if (cl) {
    const v = run("claude", ["--version"]).stdout.trim();
    ok(`Claude Code CLI found (${v}) — enables the subscription route`);
    const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
    if (m && (Number(m[1]) < 2 || (Number(m[1]) === 2 && (Number(m[2]) < 1 || (Number(m[2]) === 1 && Number(m[3]) < 280))))) warn("Claude Code < 2.1.280: Opus 5.5 will not work through the bridge — run `claude update`");
  } else warn("Claude Code CLI not found — only the Claude API key route (or no Claude) is possible. Install: https://docs.claude.com/claude-code");
  const cx = which("codex");
  if (cx) {
    ok(`Codex CLI found (${run("codex", ["--version"]).stdout.trim()}) — enables the ChatGPT Plus/Pro route`);
    const st = run("codex", ["login", "status"]);
    (st.status === 0 ? ok : warn)(st.status === 0 ? "Codex is signed in" : "Codex is not signed in — run: codex login   (or: codex login --device-auth)");
  } else info("Codex CLI not found (only needed to use ChatGPT Plus/Pro: npm i -g @openai/codex, then codex login)");
  if (which("copilot")) ok("GitHub Copilot CLI found — enables the paid Copilot plan route (then: copilot login)");
  else info("GitHub Copilot CLI not found (only needed to use a paid Copilot plan's models: npm install -g @github/copilot)");
  const code = findCode();
  if (code) ok(`VS Code command line found (${code})`); else warn("VS Code `code` command not found — the extension must be installed by hand (Extensions view → … → Install from VSIX)");
  for (const [port, name] of [[4000, "gateway"], [20128, "OmniRoute"], [4100, "claude-bridge"]]) {
    const open = await portOpen(port);
    info(`port ${port} (${name}): ${open ? "in use (running, or something else)" : "free"}`);
  }
  console.log(readEnv() ? "\n.env exists." : "\nNo .env yet — next: node ar.mjs init");
  process.exitCode = fatal ? 1 : 0;
}

// ---------------------------------------------------------------- init
const KEY_LINKS = {
  OPENAI_API_KEY: "OpenAI API (billed separately from ChatGPT Plus): https://platform.openai.com/api-keys",
  GEMINI_API_KEY: "Google AI Studio (project WITH billing): https://aistudio.google.com/apikey",
  GEMINI_FREE_API_KEY: "Google AI Studio → 'Create API key in new project' (NO billing): https://aistudio.google.com/apikey",
  ANTHROPIC_API_KEY: "Anthropic Console → Plans & Billing (credits) then API Keys: https://console.anthropic.com",
  GROQ_API_KEY: "https://console.groq.com/keys",
  OPENROUTER_API_KEY: "https://openrouter.ai/keys",
  MISTRAL_API_KEY: "https://console.mistral.ai/api-keys",
  OLLAMA_API_KEY: "https://ollama.com/settings/keys",
  NVIDIA_API_KEY: "https://build.nvidia.com (free NVIDIA Developer Program)",
  CLOUDFLARE_API_TOKEN: "Cloudflare dashboard → Workers AI → Use REST API → create the Workers AI token (also shows CLOUDFLARE_ACCOUNT_ID): https://dash.cloudflare.com",
};
function init(flags) {
  const profile = String(flags.profile || "A").toUpperCase();
  const auto = profile === "AUTO";
  const pf = path.join(ROOT, "profiles", `routing.${auto ? "A" : profile}.yaml`);
  if (!fs.existsSync(pf)) { bad(`unknown profile ${profile} (use A-F or auto — see profiles/)`); process.exit(1); }
  const claude = String(flags.claude || "cli");
  if (!["cli", "api", "none"].includes(claude)) { bad("--claude must be cli, api or none"); process.exit(1); }
  const openai = String(flags.openai || "cli");
  if (!["cli", "api", "none"].includes(openai)) { bad("--openai must be cli, api or none"); process.exit(1); }
  const rootsRaw = flags.roots || flags.root;
  if (!rootsRaw || rootsRaw === true) {
    bad("--roots is required: the folder(s) where you keep code, e.g.  --roots \"" + path.join(os.homedir(), "code") + "\"");
    info("Claude Code (bridge) is only allowed to edit inside these folders. Several: comma-separated.");
    process.exit(1);
  }
  const roots = String(rootsRaw).split(",").map((r) => path.resolve(r.trim().replace(/^~(?=$|[\\/])/, os.homedir())));
  const missing = roots.filter((r) => !fs.existsSync(r));
  if (missing.length) { bad(`folder does not exist: ${missing.join(", ")}`); process.exit(1); }

  if (fs.existsSync(ENV_FILE) && !flags.force) {
    warn(".env already exists — keeping it (use --force to recreate). Updating profile and local config only.");
  } else {
    let t = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
    t = setEnvText(t, "LITELLM_MASTER_KEY", "sk-" + crypto.randomBytes(16).toString("hex"));
    t = setEnvText(t, "BRIDGE_KEY", crypto.randomBytes(16).toString("hex"));
    t = setEnvText(t, "OMNIROUTE_PASSWORD", crypto.randomBytes(12).toString("hex"));
    t = setEnvText(t, "BRIDGE_ALLOWED_ROOTS", roots.join(","));
    t = setEnvText(t, "CLAUDE_PRIMARY", claude === "api" ? "api" : "cli");
    t = setEnvText(t, "OPENAI_PRIMARY", openai === "api" ? "api" : "cli");
    if (["C", "D", "F"].includes(profile) || (auto && !String(flags.families ?? "").includes("gemini") && flags.families !== undefined)) t = setEnvText(t, "CLASSIFIER_MODEL", "pool");
    fs.writeFileSync(ENV_FILE, t, { mode: 0o600 });
    ok("created .env with generated secrets (permissions restricted)");
  }
  // routing profile
  const target = path.join(ROOT, "litellm", "routing.yaml");
  let routingText = fs.readFileSync(pf, "utf8");
  if (auto) {
    const families = flags.families !== undefined ? String(flags.families).split(",").map((x) => x.trim()).filter(Boolean) : familiesFrom(detectPlans());
    const bad2 = families.filter((f) => !LADDER[f]);
    if (bad2.length) { bad(`unknown family: ${bad2.join(", ")} (use claude, openai, copilot, gemini)`); process.exit(1); }
    routingText = buildRoutingText(families, String(flags.pool ?? "yes") !== "no", routingText);
    info(`routing built for: ${families.join(", ") || "free providers only"}`);
  }
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== routingText) fs.copyFileSync(target, target + ".bak");
  fs.writeFileSync(target, routingText);
  ok(`routing profile ${auto ? "auto" : profile} → litellm/routing.yaml`);
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(HOME_CFG_DIR, { recursive: true });
  fs.writeFileSync(path.join(HOME_CFG_DIR, "config.json"), JSON.stringify({ repo: ROOT, stateFile: path.join(DATA, "context-state.json") }, null, 2));
  ok(`remembered this folder in ${path.join(HOME_CFG_DIR, "config.json")} (used by the VS Code extension)`);

  console.log("\nNext: put the keys you have into .env (leave the others empty). Where to get them:");
  for (const [k, v] of Object.entries(KEY_LINKS)) info(`${k.padEnd(20)} ${v}`);
  info("Claude subscription: nothing to create — just be logged in to the `claude` CLI.");
  info("ChatGPT Plus/Pro: nothing to create — install the Codex CLI and run `codex login` (then: node ar.mjs openai).");
  info("Step-by-step for every key: docs/GET-KEYS.md   |   then verify them all: node ar.mjs keys --check");
  console.log("\nThen: node ar.mjs keys --check   →   node ar.mjs up   →   node ar.mjs omniroute   →   (OpenAI: node ar.mjs openai)   →   node ar.mjs vscode   →   node ar.mjs smoke");
}

const CHECKS = {
  GEMINI_API_KEY: (k) => ["https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { "x-goog-api-key": k }],
  GEMINI_FREE_API_KEY: (k) => ["https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { "x-goog-api-key": k }],
  ANTHROPIC_API_KEY: (k) => ["https://api.anthropic.com/v1/models?limit=1", { "x-api-key": k, "anthropic-version": "2023-06-01" }],
  OPENAI_API_KEY: (k) => ["https://api.openai.com/v1/models", { authorization: `Bearer ${k}` }],
  GROQ_API_KEY: (k) => ["https://api.groq.com/openai/v1/models", { authorization: `Bearer ${k}` }],
  OPENROUTER_API_KEY: (k) => ["https://openrouter.ai/api/v1/auth/key", { authorization: `Bearer ${k}` }],
  MISTRAL_API_KEY: (k) => ["https://api.mistral.ai/v1/models", { authorization: `Bearer ${k}` }],
  OLLAMA_API_KEY: (k) => ["https://ollama.com/v1/models", { authorization: `Bearer ${k}` }],
  NVIDIA_API_KEY: (k) => ["https://integrate.api.nvidia.com/v1/models", { authorization: `Bearer ${k}` }],
};
const HINTS = {
  401: "the provider says the key is wrong — copy it again from the key page (docs/GET-KEYS.md)",
  403: "the key is not allowed (new keys can take a few minutes; or the project/plan lacks access)",
  429: "rate limited right now, but the key itself was accepted",
};
async function keys(flags) {
  const e = readEnv();
  if (!e) return bad("no .env — run: node ar.mjs init");
  for (const k of Object.keys(KEY_LINKS)) {
    if (!e[k]) { console.log(`${c(90, "empty")}  ${k}`); continue; }
    if (!flags.check || !CHECKS[k]) { console.log(`${c(32, "set  ")}  ${k}`); continue; }
    const [url, headers] = CHECKS[k](e[k]);
    const r = await http(url, { headers, timeout: 20000 });
    if (r.status === 200 || r.status === 429) console.log(`${c(32, "works")}  ${k}${r.status === 429 ? " (rate limited now)" : ""}`);
    else console.log(`${c(31, "FAILS")}  ${k}: HTTP ${r.status} — ${HINTS[r.status] || r.text.slice(0, 100)}`);
  }
  if (e.CLOUDFLARE_API_TOKEN || e.CLOUDFLARE_ACCOUNT_ID) {
    if (!e.CLOUDFLARE_API_TOKEN || !e.CLOUDFLARE_ACCOUNT_ID) console.log(`${c(31, "FAILS")}  Cloudflare needs BOTH CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN`);
    else if (!flags.check) console.log(`${c(32, "set  ")}  CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN`);
    else console.log(await cloudflareCheck(e));
  } else console.log(`${c(90, "empty")}  CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN`);
  info(`CLAUDE_PRIMARY=${e.CLAUDE_PRIMARY}  OPENAI_PRIMARY=${e.OPENAI_PRIMARY}  FREE_POOL_ENABLED=${e.FREE_POOL_ENABLED}  CLASSIFIER_MODEL=${e.CLASSIFIER_MODEL}`);
  if (flags.check) info("Subscriptions are checked by `node ar.mjs doctor` (claude / codex logged in?).");
}
async function cloudflareCheck(e) {
  const r = await http(`https://api.cloudflare.com/client/v4/accounts/${e.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?per_page=1`,
    { headers: { authorization: `Bearer ${e.CLOUDFLARE_API_TOKEN}` }, timeout: 20000 });
  if (r.status === 200 && r.json?.success) return `${c(32, "works")}  Cloudflare Workers AI (account + token)`;
  const v = await http("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: { authorization: `Bearer ${e.CLOUDFLARE_API_TOKEN}` }, timeout: 15000 });
  const tokenOk = v.json?.result?.status === "active";
  const why = tokenOk
    ? "the token is valid but is not allowed on this account/Workers AI: create it from the Workers AI page → Use REST API → template 'Workers AI', and copy the Account ID from that same page (docs/GET-KEYS.md)"
    : "the token itself is not valid — create a new one (docs/GET-KEYS.md)";
  return `${c(31, "FAILS")}  Cloudflare: HTTP ${r.status} ${(r.json?.errors?.[0]?.message) || ""} — ${why}`;
}

// ---------------------------------------------------------------- routing generator (profile "auto")
export const LADDER = {
  claude: { lo: "claude-haiku", mid: "claude-sonnet", hi: "claude-opus" },
  openai: { lo: "gpt-mini", mid: "gpt-main", hi: "gpt-max" },
  copilot: { lo: "copilot-mini", mid: "copilot-main", hi: "copilot-max" },
  gemini: { lo: "gemini-flash-lite", mid: "gemini-flash", hi: "gemini-pro" },
};
const STRENGTH = ["claude", "openai", "copilot", "gemini"];   // who leads the Smart profile
const CHEAPNESS = ["gemini", "copilot", "claude", "openai"];  // who covers the cheap rungs of Balanced
function tiersYaml(tiers) {
  const merged = [];
  for (const t of tiers) {
    const last = merged[merged.length - 1];
    if (last && last.model === t.model && last.effort === t.effort) last.max = t.max; else merged.push({ ...t });
  }
  return merged.map((t) => `    - {max_complexity: ${t.max}, model: ${t.model}${t.effort ? `, effort: ${t.effort}` : ""}}`).join("\n");
}
export function buildRoutingText(families, pool, base) {
  const fams = STRENGTH.filter((f) => families.includes(f));
  const best = fams[0], cheap = CHEAPNESS.find((f) => fams.includes(f));
  const free = [{ max: 2, model: "free-pool-fast" }, { max: 5, model: "free-pool-coding" }];
  let balanced, smart;
  if (!best) { balanced = free; smart = [{ max: 5, model: "free-pool-coding" }]; }
  else {
    const B = LADDER[best], C = LADDER[cheap];
    balanced = [{ max: 1, model: pool ? "free-pool-fast" : C.lo }, { max: 2, model: C.lo }, { max: 3, model: C.mid },
      { max: 4, model: B.mid, effort: "low" }, { max: 5, model: B.mid, effort: "medium" }];
    smart = [{ max: 1, model: B.lo }, { max: 2, model: B.mid, effort: "low" }, { max: 3, model: B.mid, effort: "medium" },
      { max: 4, model: B.hi, effort: "medium" }, { max: 5, model: B.hi, effort: "high" }];
  }
  const freeTiers = pool ? free : (best ? [{ max: 5, model: "gemini-free-flash-lite" }] : free);
  const head = base.slice(0, base.indexOf("modes:")).replace(/^# Profile .*\n/, "");
  const tail = base.slice(base.indexOf("# Pins:"));
  return `# Profile "auto": generated by \`node ar.mjs init --profile auto\` for: ${fams.join(", ") || "free providers only"}${pool ? " + free pool" : ""}. Edit freely.\n` + head +
    `modes:\n  free:\n${tiersYaml(freeTiers)}\n  balanced:\n${tiersYaml(balanced)}\n  smart:\n${tiersYaml(smart)}\n\n` + tail;
}

// ---------------------------------------------------------------- detect
function tryJson(cmd, args) { const r = run(cmd, args); try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } }
export function detectPlans() {
  const e = readEnv() || {};
  const out = { claude: { cli: false }, openai: { cli: false }, copilot: { cli: false }, gemini: {}, keys: {} };
  if (which("claude")) {
    const st = tryJson("claude", ["auth", "status"]);
    out.claude = { cli: true, loggedIn: st ? Boolean(st.loggedIn) : null, plan: st?.subscriptionType || null };
  }
  out.claude.apiKey = Boolean(e.ANTHROPIC_API_KEY);
  if (which("codex")) out.openai = { cli: true, loggedIn: run("codex", ["login", "status"]).status === 0 };
  out.openai.apiKey = Boolean(e.OPENAI_API_KEY);
  out.copilot.cli = Boolean(which("copilot"));
  if (which("gh")) {
    const u = tryJson("gh", ["api", "copilot_internal/user"]); // best effort: an undocumented GitHub endpoint that editors also use
    if (u) out.copilot = { ...out.copilot, ghSignedIn: true, plan: u.copilot_plan || null, sku: u.access_type_sku || null,
      paid: Boolean(u.access_type_sku && !/free|limited/i.test(u.access_type_sku)), cliAllowed: u.cli_enabled ?? null };
    else out.copilot.ghSignedIn = run("gh", ["auth", "status"]).status === 0;
  }
  out.gemini = { paidKey: Boolean(e.GEMINI_API_KEY), freeKey: Boolean(e.GEMINI_FREE_API_KEY) };
  out.keys = Object.fromEntries(PROVIDERS.map(([k, id]) => [id, Boolean(e[k])]).concat([["cloudflare", Boolean(e.CLOUDFLARE_API_TOKEN && e.CLOUDFLARE_ACCOUNT_ID)]]));
  return out;
}
export function familiesFrom(d) {
  const f = [];
  if ((d.claude.cli && d.claude.loggedIn !== false) || d.claude.apiKey) f.push("claude");
  if ((d.openai.cli && d.openai.loggedIn) || d.openai.apiKey) f.push("openai");
  if (d.copilot.cli && d.copilot.paid) f.push("copilot");
  if (d.gemini.paidKey) f.push("gemini");
  return f;
}
function detect(flags) {
  const d = detectPlans();
  if (flags.json) return console.log(JSON.stringify(d, null, 2));
  const yn = (v) => (v === true ? c(32, "yes") : v === false ? c(90, "no") : c(33, "unknown"));
  console.log("What this computer has (nothing here is sent anywhere; no e-mails or keys are printed)\n");
  console.log(`Claude        CLI: ${yn(d.claude.cli)}  signed in: ${yn(d.claude.loggedIn)}  plan: ${d.claude.plan || "?"}   |  API key in .env: ${yn(d.claude.apiKey)}`);
  console.log(`ChatGPT/Codex CLI: ${yn(d.openai.cli)}  signed in: ${yn(d.openai.loggedIn)}  (Plus/Pro cannot be told apart)   |  OpenAI API key in .env: ${yn(d.openai.apiKey)}`);
  console.log(`GitHub Copilot CLI: ${yn(d.copilot.cli)}  GitHub account: ${yn(d.copilot.ghSignedIn)}  plan: ${d.copilot.plan || "?"} (${d.copilot.sku || "?"}) paid: ${yn(d.copilot.paid)}  Copilot CLI allowed: ${yn(d.copilot.cliAllowed)}`);
  console.log(`Gemini        billed key: ${yn(d.gemini.paidKey)}  free-tier key: ${yn(d.gemini.freeKey)}`);
  console.log(`Free pool keys in .env: ${Object.entries(d.keys).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`);
  const fams = familiesFrom(d);
  console.log(`\nSuggested routing families: ${fams.join(", ") || "none (free providers only)"}`);
  console.log("Always confirm with the person: a login can be on a free plan, and the paid tier (Plus vs Pro, Pro vs Max) is not always visible.");
  if (d.claude.cli && d.claude.loggedIn === false) info("Claude Code is installed but not signed in: run `claude`.");
  if (d.openai.cli && !d.openai.loggedIn) info("Codex is installed but not signed in: run `codex login`.");
  if (d.copilot.ghSignedIn && d.copilot.paid && !d.copilot.cli) info("Paid Copilot plan found but no Copilot CLI: npm install -g @github/copilot, then run `copilot login`.");
  if (d.copilot.ghSignedIn && d.copilot.paid === false) info("This GitHub account is on a free Copilot plan; paid-plan models are not available through it.");
}

// ---------------------------------------------------------------- copilot
const CP_BEGIN = "  # >>> copilot (managed by ar.mjs)", CP_END = "  # <<< copilot";
const CPF_BEGIN = "    # >>> copilot-fallbacks (managed by ar.mjs)", CPF_END = "    # <<< copilot-fallbacks";
export function copilotBlocks({ hasGemini }) {
  const models = ["mini", "main", "max"].map((t) => `  - {model_name: copilot-${t}, litellm_params: {model: openai/copilot-code-${t}, api_base: http://host.docker.internal:4100/v1, api_key: os.environ/BRIDGE_KEY}}`).join("\n");
  const fallbacks = hasGemini ? ["mini", "main", "max"].map((t) => `    - {copilot-${t}: [gemini-flash-lite]}`).join("\n") : "";
  return { models, fallbacks };
}
async function copilot(flags) {
  const e = readEnv();
  if (!e) return bad("no .env — run: node ar.mjs init");
  if (!which("copilot")) return bad("Copilot CLI not found. Install: npm install -g @github/copilot  (or winget install GitHub.Copilot / brew install --cask copilot-cli), then run: copilot login");
  const d = detectPlans().copilot;
  if (d.paid === false) warn(`this GitHub account reports a free Copilot plan (${d.sku}); the CLI may refuse paid models`);
  if (d.cliAllowed === false) warn("GitHub says the Copilot CLI is disabled for this account/organization");
  const ids = { mini: flags.mini, main: flags.main, max: flags.max };
  const given = (t) => (ids[t] && ids[t] !== true ? ids[t] : "");
  if (flags.check) {
    for (const t of ["mini", "main", "max"]) {
      if (!given(t) && t !== "main") continue;
      const r = run("copilot", ["-p", "Reply with one word: ok", "-s", "--no-ask-user", ...(given(t) ? [`--model=${given(t)}`] : [])], { timeout: 180000, env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "", COPILOT_GITHUB_TOKEN: "" } });
      (r.status === 0 && r.stdout.trim() ? ok : bad)(`Copilot CLI${given(t) ? " " + given(t) : " (default model)"}: ${r.status === 0 && r.stdout.trim() ? "answers" : (r.stderr || r.stdout || "failed").trim().slice(-200)}`);
    }
    return info("Each check uses one Copilot request (premium models count against your plan's monthly premium requests).");
  }
  const cfgPath = path.join(ROOT, "litellm", "config.yaml");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  const b = copilotBlocks({ hasGemini: Boolean(e.GEMINI_API_KEY) });
  cfg = applyBlocks(applyBlocks(cfg, CP_BEGIN, CP_END, b.models), CPF_BEGIN, CPF_END, b.fallbacks);
  fs.writeFileSync(cfgPath, cfg);
  for (const [t, k] of [["mini", "COPILOT_MODEL_MINI"], ["main", "COPILOT_MODEL_MAIN"], ["max", "COPILOT_MODEL_MAX"]]) setEnv(k, given(t));
  ok("GitHub Copilot configured: copilot-mini / copilot-main / copilot-max");
  info("Models: " + (given("main") || given("mini") || given("max") ? `mini=${given("mini") || "default"} main=${given("main") || "default"} max=${given("max") || "default"}` : "the CLI's default model for all three (choose with --mini/--main/--max; run `copilot` and type /model to see the names your plan offers)"));
  info("Verify: node ar.mjs copilot --main <id> --check   |   use it: node ar.mjs init --roots <folders> --profile auto   |   pins: !copilot, !copilot-max, !copilot-mini");
  info("Apply: node ar.mjs down && node ar.mjs up");
}

async function cloudflareToken() {
  const e = readEnv();
  if (!e?.CLOUDFLARE_API_TOKEN || !e?.CLOUDFLARE_ACCOUNT_ID) return bad("put CLOUDFLARE_ACCOUNT_ID and the current CLOUDFLARE_API_TOKEN in .env first");
  const auth = { authorization: `Bearer ${e.CLOUDFLARE_API_TOKEN}` };
  if ((await cloudflareCheck(e)).includes("works")) return ok("the current token already works with Workers AI — nothing to do");
  const g = await http("https://api.cloudflare.com/client/v4/user/tokens/permission_groups", { headers: auth });
  if (!g.json?.success) return bad("this token cannot list permissions, so it cannot create tokens either. Create the Workers AI token in the dashboard (docs/GET-KEYS.md).");
  const ids = ["Workers AI Read", "Workers AI Write"].map((n) => g.json.result.find((x) => x.name === n)?.id);
  if (ids.some((i) => !i)) return bad("could not find the Workers AI permission groups on this account");
  const r = await http("https://api.cloudflare.com/client/v4/user/tokens", { method: "POST", headers: auth, body: {
    name: "auto-router-workers-ai",
    policies: [{ effect: "allow", resources: { [`com.cloudflare.api.account.${e.CLOUDFLARE_ACCOUNT_ID}`]: "*" }, permission_groups: ids.map((id) => ({ id })) }] } });
  if (!r.json?.success) return bad(`Cloudflare refused: ${(r.json?.errors || []).map((x) => x.message).join("; ") || r.text.slice(0, 120)}`);
  setEnv("CLOUDFLARE_API_TOKEN", r.json.result.value);
  ok("created token 'auto-router-workers-ai' (Workers AI only, this account) and saved it in .env");
  await sleep(3000);
  console.log(await cloudflareCheck(readEnv()));
  info("Now delete the old token in the Cloudflare dashboard (My Profile → API Tokens); it is no longer needed.");
}

// ---------------------------------------------------------------- openai
const OPENAI_BEGIN = "  # >>> openai (managed by ar.mjs)", OPENAI_END = "  # <<< openai";
const FB_BEGIN = "    # >>> openai-fallbacks (managed by ar.mjs)", FB_END = "    # <<< openai-fallbacks";
export function openaiBlocks({ route, ids, hasGemini }) {
  const tiers = ["mini", "main", "max"];
  const models = [], fallbacks = [];
  for (const t of tiers) {
    if (route !== "api") models.push(`  - {model_name: gpt-${t}-cli, litellm_params: {model: openai/codex-code-${t}, api_base: http://host.docker.internal:4100/v1, api_key: os.environ/BRIDGE_KEY}}`);
    if (route !== "cli") models.push(`  - {model_name: gpt-${t}-api, litellm_params: {model: openai/${ids[t]}, api_key: os.environ/OPENAI_API_KEY}}`);
    const tail = hasGemini ? ", gemini-flash-lite" : "";
    if (route === "both") {
      fallbacks.push(`    - {gpt-${t}-cli: [gpt-${t}-api${tail}]}`, `    - {gpt-${t}-api: [gpt-${t}-cli${tail}]}`);
    } else if (tail) fallbacks.push(`    - {gpt-${t}-${route}: [gemini-flash-lite]}`);
  }
  return { models: models.join("\n"), fallbacks: fallbacks.join("\n") };
}
export function applyBlocks(text, begin, end, body) {
  const a = text.indexOf(begin), b = text.indexOf(end);
  if (a < 0 || b < 0 || b < a) throw new Error(`marker ${begin.trim()} not found in config.yaml`);
  return text.slice(0, a + begin.length) + "\n" + (body ? body + "\n" : "") + text.slice(b);
}
async function openai(flags) {
  const e = readEnv();
  if (!e) return bad("no .env — run: node ar.mjs init");
  const hasCodex = Boolean(which("codex")), hasKey = Boolean(e.OPENAI_API_KEY);
  if (flags.list) {
    if (hasKey) {
      const r = await http("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${e.OPENAI_API_KEY}` } });
      if (r.status !== 200) return bad(`OpenAI API: HTTP ${r.status} ${r.text.slice(0, 120)}`);
      const ids = (r.json.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d|codex)/.test(id) && !/(audio|realtime|tts|transcribe|image|embedding|search|moderation)/.test(id)).sort();
      console.log("Models this API key can use (chat-capable, filtered):"); ids.forEach((id) => info(id));
    } else info("No OPENAI_API_KEY in .env, so the API model list is unavailable.");
    if (hasCodex) info("Codex CLI models: run `codex`, type /model — the names listed there are the ones to pass to --mini/--main/--max. Leaving them empty uses Codex's default model.");
    return;
  }
  const route = String(flags.route || (hasKey && hasCodex ? "both" : hasKey ? "api" : "cli"));
  if (!["cli", "api", "both"].includes(route)) return bad("--route must be cli, api or both");
  if (route !== "api" && !hasCodex) return bad("Codex CLI not found. Install it (npm i -g @openai/codex), run `codex login`, or use --route api with OPENAI_API_KEY.");
  if (route !== "cli" && !hasKey) return bad("OPENAI_API_KEY is empty in .env (the API is billed separately from ChatGPT Plus). Use --route cli or add a key.");
  if (route !== "api") {
    const st = run("codex", ["login", "status"]);
    if (st.status !== 0) warn("Codex is not signed in yet — run: codex login   (headless machine: codex login --device-auth)");
    else ok("Codex is signed in");
  }
  const ids = { mini: flags.mini, main: flags.main, max: flags.max };
  if (route !== "cli") for (const t of ["mini", "main", "max"]) if (!ids[t] || ids[t] === true) return bad(`--${t} <model id> is required for the API route (see: node ar.mjs openai --list)`);
  if (flags.check) {
    if (route !== "cli") for (const t of ["mini", "main", "max"]) {
      const r = await http("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${e.OPENAI_API_KEY}` }, timeout: 60000,
        body: { model: ids[t], messages: [{ role: "user", content: "Reply with one word: ok" }] } });
      (r.status === 200 ? ok : bad)(`API ${ids[t]}: ${r.status === 200 ? "answers" : "HTTP " + r.status + " " + (r.json?.error?.message || "").slice(0, 100)}`);
    }
    if (route !== "api") {
      const r = run("codex", ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", ...(ids.main && ids.main !== true ? ["-m", ids.main] : []), "Reply with one word: ok"], { timeout: 120000, input: "" });
      (r.status === 0 ? ok : bad)(`Codex CLI: ${r.status === 0 ? "answers" : (r.stderr || r.stdout || "failed").slice(-200)}`);
    }
    return;
  }
  const cfgPath = path.join(ROOT, "litellm", "config.yaml");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  const blocks = openaiBlocks({ route, ids, hasGemini: Boolean(e.GEMINI_API_KEY) });
  cfg = applyBlocks(cfg, OPENAI_BEGIN, OPENAI_END, blocks.models);
  cfg = applyBlocks(cfg, FB_BEGIN, FB_END, blocks.fallbacks);
  fs.writeFileSync(cfgPath, cfg);
  setEnv("OPENAI_PRIMARY", route === "api" ? "api" : "cli");
  if (route !== "api") for (const [t, k] of [["mini", "CODEX_MODEL_MINI"], ["main", "CODEX_MODEL_MAIN"], ["max", "CODEX_MODEL_MAX"]]) setEnv(k, ids[t] && ids[t] !== true ? ids[t] : "");
  ok(`OpenAI configured: route=${route}${route === "both" ? " (cli first, api as fallback)" : ""}`);
  info("Models: " + (route === "api" || route === "both" ? `mini=${ids.mini} main=${ids.main} max=${ids.max}` : "Codex's default model for mini/main/max (set --mini/--main/--max to choose)"));
  info("Use OpenAI in the profiles: node ar.mjs init --roots <folders> --profile E (with Gemini) or F (free pool only) — re-running init keeps your .env. Or add gpt-mini/gpt-main/gpt-max to litellm/routing.yaml. The pins !gpt, !gpt-max, !gpt-mini already work.");
  info("Apply: node ar.mjs down && node ar.mjs up   (restarts the bridge and the gateway)");
}

// ---------------------------------------------------------------- bridge process
const PID_FILE = path.join(DATA, "bridge.pid");
async function bridgeUp() {
  if (await portOpen(4100)) return ok("claude-bridge already running on :4100");
  const e = readEnv() || {};
  if (e.CLAUDE_PRIMARY === "api" || !which("claude")) return info("claude-bridge not started (no Claude CLI route configured)");
  fs.mkdirSync(DATA, { recursive: true });
  const log = fs.openSync(path.join(DATA, "bridge.log"), "a");
  const child = spawn(process.execPath, [path.join(ROOT, "claude-bridge", "start.mjs")], { cwd: ROOT, detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 20; i++) { await sleep(300); if (await portOpen(4100)) return ok(`claude-bridge started (pid ${child.pid}, log: data/bridge.log)`); }
  bad("claude-bridge did not start — see data/bridge.log");
}
function bridgeDown() {
  try { process.kill(Number(fs.readFileSync(PID_FILE, "utf8"))); ok("claude-bridge stopped"); } catch { info("claude-bridge: nothing to stop (not started by this script)"); }
  try { fs.unlinkSync(PID_FILE); } catch {}
}

async function up(flags) {
  if (!readEnv()) return bad("no .env — run: node ar.mjs init");
  const r = compose(["up", "-d"]);
  if (r.status !== 0) return bad("docker compose failed");
  process.stdout.write("waiting for the gateway");
  for (let i = 0; i < 90; i++) {
    const h = await http(`${GATEWAY}/health/liveliness`, { timeout: 3000 });
    if (h.status === 200) { console.log(""); ok("gateway is up on 127.0.0.1:4000"); break; }
    process.stdout.write("."); await sleep(2000);
    if (i === 89) { console.log(""); bad("gateway did not come up — run: docker compose logs litellm"); return; }
  }
  if (!flags["no-bridge"]) await bridgeUp();
}
async function down() { compose(["down"]); bridgeDown(); }
async function status() {
  const g = await http(`${GATEWAY}/health/liveliness`, { timeout: 3000 });
  (g.status === 200 ? ok : bad)(`gateway :4000 ${g.status === 200 ? "up" : "down"}`);
  (await portOpen(20128) ? ok : bad)("OmniRoute :20128 " + ((await portOpen(20128)) ? "up" : "down"));
  const b = await http(`${BRIDGE}/healthz`, { timeout: 2000 });
  (b.status === 200 ? ok : warn)(`claude-bridge :4100 ${b.status === 200 ? "up" : "down (only needed for the Claude CLI route)"}`);
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA, "context-state.json"), "utf8"));
    info(`last session: ${s.mode} → ${s.model}, context ${s.ctx_pct}%, quota ${s.quota?.state}`);
  } catch {}
}

// ---------------------------------------------------------------- omniroute
const PROVIDERS = [["GROQ_API_KEY", "groq"], ["MISTRAL_API_KEY", "mistral"], ["OPENROUTER_API_KEY", "openrouter"],
  ["OLLAMA_API_KEY", "ollama-cloud"], ["NVIDIA_API_KEY", "nvidia"]];

async function omniroute(flags) {
  const e = readEnv();
  if (!e) return bad("no .env — run: node ar.mjs init");
  if (!(await portOpen(20128))) return bad("OmniRoute is not running — run: node ar.mjs up");
  const cf = Boolean(e.CLOUDFLARE_API_TOKEN && e.CLOUDFLARE_ACCOUNT_ID);
  let cfOk = false;
  if (cf) {
    const msg = await cloudflareCheck(e);
    if (msg.includes("works")) {
      cfOk = true; ok("Cloudflare credentials work");
      const inside = spawnSync("docker", ["compose", "exec", "-T", "omniroute", "printenv", "CLOUDFLARE_ACCOUNT_ID"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim();
      if (inside !== e.CLOUDFLARE_ACCOUNT_ID) {
        warn("OmniRoute does not know the Cloudflare account id yet — recreating its container (data is kept)");
        compose(["up", "-d", "--force-recreate", "omniroute"], { stdio: "ignore" });
        for (let i = 0; i < 40 && !(await portOpen(20128)); i++) await sleep(1500);
        await sleep(6000);
      }
    } else warn(msg.replace(/\x1b\[[0-9;]*m/g, "") + "\n  → Cloudflare is skipped for now; fix the credentials and rerun this command.");
  }
  const login = await http(`${OMNI}/api/auth/login`, { method: "POST", body: { password: e.OMNIROUTE_PASSWORD } });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  if (login.status !== 200 || !cookie) return bad(`OmniRoute login failed (${login.status}). If the container was created before init, recreate it: docker compose up -d --force-recreate omniroute`);
  const api = (p, o = {}) => http(`${OMNI}${p}`, { ...o, headers: { cookie, ...(o.headers || {}) } });
  ok("logged in to OmniRoute");

  let poolKey = e.FREE_POOL_KEY;
  if (!poolKey) {
    const k = await api("/api/keys", { method: "POST", body: { name: "auto-router" } });
    if (!k.json?.key) return bad(`could not create the OmniRoute API key: ${k.text.slice(0, 120)}`);
    poolKey = k.json.key; setEnv("FREE_POOL_KEY", poolKey); ok("created the OmniRoute API key and saved it in .env");
  }

  const want = PROVIDERS.filter(([k]) => e[k]).map(([k, id]) => [id, e[k]]);
  if (cfOk) want.push(["cloudflare-ai", e.CLOUDFLARE_API_TOKEN]);
  if (!flags["no-llm7"]) want.push(["llm7", "unused"]);
  if (!want.length) return bad("no provider keys in .env yet (and --no-llm7 given) — add keys, then rerun");
  const have = (await api("/api/providers")).json?.connections || [];
  const connected = new Set();
  const connect = async (id, key) => {
    const existing = have.find((x) => x.provider === id);
    let connId = existing?.id;
    if (!connId) {
      const r = await api("/api/providers", { method: "POST", body: { provider: id, name: id, apiKey: key } });
      connId = r.json?.connection?.id;
      if (!connId) { bad(`${id}: could not register (${r.text.slice(0, 100)})`); return null; }
    }
    const t = await api(`/api/providers/${connId}/test`, { method: "POST" });
    if (t.json?.valid) { ok(`${id}: connected`); connected.add(id); return connId; }
    bad(`${id}: key rejected (${t.json?.error || t.text.slice(0, 80)})`); return null;
  };
  const connIds = {};
  for (const [id, key] of want) connIds[id] = await connect(id, key);

  // verify every candidate model with a real request, keep the ones that answer
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "profiles", "pool-models.json"), "utf8"));
  if (cfOk && connIds["cloudflare-ai"]) { // Workers AI model ids are discovered, then verified like all others
    const list = (await api(`/api/providers/${connIds["cloudflare-ai"]}/models`)).json?.models || [];
    const prefs = [/llama-3\.3-70b/, /gpt-oss-120b/, /gpt-oss-20b/, /glm-4\.7/, /gemma-4/, /qwen.*coder/];
    const picked = [];
    for (const re of prefs) { const m = list.find((x) => re.test(x.id) && !picked.includes(x.id)); if (m) picked.push(m.id); }
    for (const id of picked.slice(0, 4)) { spec["free-coding"].push(`cloudflare-ai/${id}`); spec["free-fast"].push(`cloudflare-ai/${id}`); }
    info(`Cloudflare Workers AI candidates: ${picked.slice(0, 4).join(", ") || "none found"}`);
  }
  const bearer = { authorization: `Bearer ${poolKey}` };
  const good = { "free-fast": [], "free-coding": [] };
  const probed = new Map();
  for (const combo of Object.keys(good)) {
    for (const model of spec[combo] || []) {
      const prov = model.split("/")[0];
      if (!connected.has(prov)) continue;
      if (!probed.has(model)) {
        let r = await http(`${OMNI}/v1/chat/completions`, { method: "POST", headers: bearer, timeout: 45000,
          body: { model, max_tokens: 200, messages: [{ role: "user", content: "Reply with one word: ok" }] } });
        if (r.status === 410 && connIds[prov]) { // OmniRoute locks a whole connection after one retired-model error: recreate it
          await api(`/api/providers/${connIds[prov]}`, { method: "DELETE" });
          connIds[prov] = await connect(prov, want.find(([i]) => i === prov)[1]);
          warn(`${prov}: a model is retired (410); connection recreated`);
        }
        const m = r.json?.choices?.[0]?.message;
        probed.set(model, r.status === 200 && (m?.content || m?.reasoning || m?.reasoning_content) ? "ok" : `fail ${r.status}`);
        await sleep(700);
      }
      if (probed.get(model) === "ok") good[combo].push(model);
    }
  }
  for (const [model, res] of probed) (res === "ok" ? ok : warn)(`${model}: ${res === "ok" ? "answers" : "dropped (" + res + ")"}`);

  const combos = (await api("/api/combos")).json?.combos || [];
  let usable = 0;
  for (const [name, models] of Object.entries(good)) {
    if (!models.length) { warn(`combo ${name}: no working model — skipped`); continue; }
    usable++;
    const ex = combos.find((x) => x.name === name);
    const r = ex ? await api(`/api/combos/${ex.id}`, { method: "PUT", body: { models } })
                 : await api("/api/combos", { method: "POST", body: { name, strategy: "priority", models } });
    (r.status < 300 ? ok : bad)(`combo ${name}: ${models.length} models${r.status < 300 ? "" : " (" + r.text.slice(0, 80) + ")"}`);
  }
  if (usable === 2) { setEnv("FREE_POOL_ENABLED", "true"); ok("FREE_POOL_ENABLED=true"); }
  else warn("both combos need at least one working model; FREE_POOL_ENABLED left as is");
  info("Apply to the gateway: docker compose up -d --force-recreate litellm");
}

// ---------------------------------------------------------------- vscode
function findCode() {
  const w = which(IS_WIN ? "code.cmd" : "code") || which("code");
  if (w) return w;
  const cands = process.platform === "darwin"
    ? ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"]
    : IS_WIN ? [path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "bin", "code.cmd")] : ["/usr/bin/code", "/snap/bin/code"];
  return cands.find((p) => fs.existsSync(p)) || null;
}
export function vscodeUserDir(flavor = "Code") {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", flavor, "User");
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), flavor, "User");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), flavor, "User");
}
export function buildProvider(masterKey) {
  const model = (id, name) => ({ id, name, url: `${GATEWAY.replace("127.0.0.1", "localhost")}/v1/chat/completions`,
    toolCalling: true, vision: false, thinking: false, streaming: true, maxInputTokens: 100000, maxOutputTokens: 16000,
    requestHeaders: { Authorization: `Bearer ${masterKey}` } });
  return { name: "auto-router", vendor: "customendpoint", apiKey: "unused", apiType: "chat-completions",
    models: [model("auto-free", "Auto: Free"), model("auto-balanced", "Auto: Balanced"), model("auto-smart", "Auto: Smart")] };
}
export function patchProviders(text, provider, remove = false) {
  let arr = [];
  if (text.trim()) {
    try { arr = JSON.parse(text); } catch { throw new Error("chatLanguageModels.json is not plain JSON (comments?). Edit it by hand using docs/VSCODE-SETUP.md"); }
    if (!Array.isArray(arr)) throw new Error("chatLanguageModels.json is not a JSON array");
  }
  arr = arr.filter((x) => x.name !== "auto-router");
  if (!remove) arr.push(provider);
  return JSON.stringify(arr, null, 2) + "\n";
}
function vscode(flags) {
  const e = readEnv();
  if (!e?.LITELLM_MASTER_KEY) return bad("no .env / LITELLM_MASTER_KEY — run: node ar.mjs init");
  const dir = flags.dir ? path.resolve(String(flags.dir)) : vscodeUserDir(flags.insiders ? "Code - Insiders" : "Code");
  const file = path.join(dir, "chatLanguageModels.json");
  fs.mkdirSync(dir, { recursive: true });
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  let next;
  try { next = patchProviders(old, buildProvider(e.LITELLM_MASTER_KEY), Boolean(flags.uninstall)); } catch (err) { return bad(err.message); }
  if (old) fs.writeFileSync(file + ".bak-auto-router", old, { mode: 0o600 });
  fs.writeFileSync(file, next, { mode: 0o600 });
  ok(`${flags.uninstall ? "removed auto-router from" : "added the Auto: Free / Balanced / Smart models to"} ${file}${old ? " (backup: .bak-auto-router)" : ""}`);
  if (!flags.uninstall) info("The gateway key sits in that file in plain text (VS Code ignores apiKey and needs requestHeaders); it only opens 127.0.0.1:4000.");
  const vsix = path.join(ROOT, "vscode-extension", "auto-router-companion.vsix");
  const code = flags.dir ? null : findCode();
  if (flags.uninstall) { if (code) run(code, ["--uninstall-extension", "local.auto-router-companion"]); return; }
  if (!code) return warn(`could not find the \`code\` command. Install the extension manually: Extensions view → … → Install from VSIX → ${vsix}`);
  const r = run(code, ["--install-extension", vsix, "--force"]);
  (r.status === 0 ? ok : warn)(r.status === 0 ? "installed the auto-router companion extension (status bar + automatic new chat)" : `extension install failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
  console.log("\nLast step (VS Code can't be scripted): Command Palette → \"Developer: Reload Window\", then pick  Auto: Free / Balanced / Smart  in the Copilot Chat model picker.");
}

// ---------------------------------------------------------------- smoke
async function smoke() {
  const e = readEnv();
  if (!e) return bad("no .env — run: node ar.mjs init");
  let fail = 0;
  const g = await http(`${GATEWAY}/health/liveliness`, { timeout: 3000 });
  if (g.status === 200) ok("gateway up"); else { bad("gateway down — node ar.mjs up"); return; }
  (await portOpen(4100) ? ok : warn)("claude-bridge " + ((await portOpen(4100)) ? "up" : "down (fine if you have no Claude CLI route)"));
  for (const model of ["auto-free", "auto-balanced", "auto-smart"]) {
    const t0 = Date.now();
    const r = await http(`${GATEWAY}/v1/chat/completions`, { method: "POST", timeout: 120000,
      headers: { authorization: `Bearer ${e.LITELLM_MASTER_KEY}` }, body: { model, max_tokens: 200, messages: [{ role: "user", content: "What is 2+2? Answer in one word." }] } });
    const text = r.json?.choices?.[0]?.message?.content;
    if (r.status === 200 && text) { const foot = text.match(/\*auto-router · (.*)\*/); ok(`${model}: ${((Date.now() - t0) / 1000).toFixed(1)}s${foot ? " — " + foot[1] : ""}`); }
    else { fail++; bad(`${model}: HTTP ${r.status} ${(r.json?.error?.message || r.text).slice(0, 140)}`); }
  }
  const errs = readEvents().filter((x) => x.type === "call" && x.status === "error" && x.ts > Date.now() / 1000 - 300 && x.model_group !== "classifier");
  if (errs.length) warn(`${errs.length} upstream call(s) failed in the last 5 min and were covered by fallbacks — see: node ar.mjs logs --errors`);
  process.exitCode = fail ? 1 : 0;
}

// ---------------------------------------------------------------- logs / usage
function readJsonl(file) {
  try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
const readEvents = () => readJsonl(path.join(DATA, "router.jsonl"));
function sinceTs(label) {
  if (!label || label === "all") return 0;
  if (label === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }
  const m = String(label).match(/^(\d+)([mhd])$/); if (!m) return 0;
  return Date.now() / 1000 - Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2]];
}
function fmtEvent(r) {
  const t = new Date(r.ts * 1000).toTimeString().slice(0, 8), rid = String(r.rid || "-").padEnd(8);
  switch (r.type) {
    case "route": {
      let extra = r.step ? ` step=${r.step}` : "";
      if (r.ctx_pct != null) extra += ` ctx=${r.ctx_pct}%`;
      if (r.quota && !["ok", "unknown"].includes(r.quota)) extra += ` quota=${r.quota}`;
      const why = r.reason && !["unchanged", "first decision"].includes(r.reason) ? ` [${r.reason}]` : "";
      return `${t} route    ${rid} ${r.requested} -> ${r.model}  task=${r.task} c=${r.complexity} effort=${r.effort} via=${r.source}${extra} (${r.classify_ms} ms)${why}${r.handoff_from ? " handoff_from=" + r.handoff_from : ""}`;
    }
    case "call": return `${t} call     ${rid} ${String(r.status).padEnd(5)} ${r.model_group} [${r.deployment}] ${r.latency_ms} ms${r.error ? "  ERROR: " + r.error : ""}`;
    case "switch": return `${t} SWITCH   ${rid} ${r.frm} -> ${r.to}  reason=${r.reason} step=${r.step}`;
    case "stream_failover": return `${t} FAILOVER ${rid} ${r.failed} -> ${r.to}  reason=${r.reason} kept ${r.partial_chars} chars`;
    case "stream_error": return `${t} STREAMERR ${rid} ${r.model} resumable=${r.resumable} ${r.error}`;
    case "compact": return `${t} compact  ${rid} ${r.model} window=${r.window} tokens_after=${r.tokens_after}`;
    default: return `${t} ${r.type} ${r.session || ""} ${r.path || r.memory || r.error || ""}`;
  }
}
async function logs(flags) {
  const since = sinceTs(flags.since);
  const keep = (r) => r.ts >= since && (!flags.type || r.type === flags.type) && (!flags.rid || r.rid === flags.rid)
    && (!flags.errors || r.status === "error" || String(r.type).startsWith("stream_") || r.type === "memory_error");
  const show = (r) => console.log(flags.raw ? JSON.stringify(r) : fmtEvent(r));
  const rows = readEvents().filter(keep);
  if (!rows.length && !flags.follow) return console.log("no events yet");
  rows.slice(-Number(flags.tail || 30)).forEach(show);
  if (!flags.follow) return;
  const file = path.join(DATA, "router.jsonl");
  let pos = fs.existsSync(file) ? fs.statSync(file).size : 0;
  for (;;) {
    await sleep(700);
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    if (size < pos) pos = 0;
    if (size > pos) {
      const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(size - pos); fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos = size;
      buf.toString().split(/\r?\n/).filter(Boolean).forEach((l) => { try { const r = JSON.parse(l); if (keep(r)) show(r); } catch {} });
    }
  }
}
function usage(flags) {
  const since = sinceTs(flags.since || "24h");
  const key = { model: "model_group", mode: "mode", task: "task" }[flags.by || "model"] || "model_group";
  const rows = readJsonl(path.join(DATA, "usage.jsonl")).filter((r) => r.ts >= since && !String(r.model_group || "").startsWith("auto-"));
  if (!rows.length) return console.log(`no usage recorded since '${flags.since || "24h"}'`);
  const groups = new Map();
  for (const r of rows) { const k = r[key] || "(none)"; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  const totTok = rows.reduce((a, r) => a + (r.total_tokens || 0), 0) || 1, totReq = rows.length;
  console.log(`Usage since ${flags.since || "24h"} (${totReq} calls, ${totTok} tokens, $${rows.reduce((a, r) => a + (r.cost_usd || 0), 0).toFixed(4)} reported cost)\n`);
  console.log(`${(flags.by || "model").padEnd(26)}${"reqs".padStart(6)}${"err".padStart(5)}${"in tok".padStart(10)}${"out tok".padStart(10)}${"%reqs".padStart(7)}${"%tokens".padStart(9)}`);
  const sum = (a, f) => a.reduce((x, r) => x + (r[f] || 0), 0);
  [...groups.entries()].sort((a, b) => sum(b[1], "total_tokens") - sum(a[1], "total_tokens")).forEach(([k, a]) =>
    console.log(`${String(k).padEnd(26)}${String(a.length).padStart(6)}${String(a.filter((r) => r.status !== "ok").length).padStart(5)}${String(sum(a, "prompt_tokens")).padStart(10)}${String(sum(a, "completion_tokens")).padStart(10)}${(100 * a.length / totReq).toFixed(1).padStart(6)}%${(100 * sum(a, "total_tokens") / totTok).toFixed(1).padStart(8)}%`));
  try {
    const q = JSON.parse(fs.readFileSync(path.join(DATA, "quota-report.json"), "utf8"));
    console.log("\nQuota forecast (from the gateway's last request)");
    const claude = JSON.parse(fs.readFileSync(path.join(DATA, "claude-quota.json"), "utf8"));
    for (const [name, w] of Object.entries(claude.windows || {}))
      console.log(`  Claude subscription ${name.padEnd(10)} ${Math.round(100 * (w.utilization || 0)).toString().padStart(3)}% used, resets ${w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString() : "?"}`);
    for (const [m, s] of Object.entries(q.models || {}).filter(([, s]) => ["warn", "critical", "exhausted"].includes(s.state)))
      console.log(`  ${m}: ${s.state}${s.window ? " (" + s.window + ")" : ""}${s.eta_min != null ? ", ~" + Math.round(s.eta_min) + " min left" : ""}`);
  } catch { console.log("\n(no quota snapshot yet — it appears after the first request)"); }
}

// ---------------------------------------------------------------- main
const HELP = `auto-router — node ar.mjs <command>

  doctor      check Docker, Node, Claude CLI, VS Code, ports
  init        --roots <folders> [--profile A-F|auto] [--families claude,openai,copilot,gemini] [--pool yes|no] [--claude cli|api|none] [--openai cli|api|none] [--force]
  keys        [--check] show which keys are set; --check tests each one against its provider
  cloudflare-token   fix "Authentication error" when CLOUDFLARE_API_TOKEN is a 'create tokens' token (docs/GET-KEYS.md)
  detect      [--json]  find out which paid plans/logins exist (never prints e-mails or keys)
  copilot     [--mini ID --main ID --max ID] [--check]   use your paid GitHub Copilot plan (Copilot CLI)
  openai      [--list] [--route cli|api|both] [--mini ID --main ID --max ID] [--check]   OpenAI via ChatGPT login (Codex CLI) and/or API key
  up | down | status
  omniroute   [--no-llm7]   connect free providers, verify models, build the combos
  vscode      [--uninstall] [--insiders] [--dir <path>]
  smoke       one request per profile
  logs        [-f] [--errors] [--tail N] [--type T] [--rid ID] [--since 30m] [--raw]
  usage       [--since 24h|7d|all] [--by model|mode|task]

Profile "auto" builds the routing from the plans you have (--families, or detected). Fixed profiles:
          A Claude + billed Gemini + free pool | B Gemini only | C Claude + free pool | D free only
          E OpenAI + billed Gemini + free pool | F OpenAI + free pool`;

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0];
  switch (cmd) {
    case "doctor": return doctor();
    case "init": return init(flags);
    case "keys": return keys(flags);
    case "openai": return openai(flags);
    case "detect": return detect(flags);
    case "copilot": return copilot(flags);
    case "cloudflare-token": return cloudflareToken();
    case "up": return up(flags);
    case "down": return down();
    case "status": return status();
    case "omniroute": return omniroute(flags);
    case "vscode": return vscode(flags);
    case "smoke": return smoke();
    case "logs": return logs(flags);
    case "usage": return usage(flags);
    default: console.log(HELP); process.exitCode = cmd ? 1 : 0;
  }
}
const realArgv = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return ""; } })();
if (realArgv && realArgv === fs.realpathSync(fileURLToPath(import.meta.url))) await main();
