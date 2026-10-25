#!/usr/bin/env node
// auto-router control script. Node >= 18, no dependencies, works on Windows, macOS and Linux.
//
//   node ar.mjs doctor                  check Docker / Node / Claude CLI / VS Code and ports
//   node ar.mjs init [options]          create .env (generated secrets), pick a routing profile, remember paths
//   node ar.mjs keys [--check]          which keys are set (names only); --check also asks each provider whether the key works
//   node ar.mjs cloudflare-token       mint a Workers-AI-only token from a token that can only create tokens (see docs/GET-KEYS.md)
//   node ar.mjs update [--apply]       update THIS install from the repository (dry run first); keeps your keys and choices
//   node ar.mjs safety [on|off|status] safety mode: on removes models that may log/train on prompts (default), off allows them
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
  // SEC-10: secrets out of the agent's reach, files private
  const modeOf = (p) => { try { return fs.statSync(p).mode & 0o777; } catch { return null; } };
  if (!IS_WIN) {
    for (const [p, want, label] of [[ENV_FILE, 0o600, ".env"], ...(process.platform === "linux" ? [] : [[DATA, 0o700, "data/"]]), [HOME_CFG_DIR, 0o700, "~/.auto-router/"]]) {
      const m = modeOf(p);
      if (m === null) continue;
      if (m & 0o077) warn(`${label} is readable by other users (mode ${m.toString(8)}) — run: chmod ${want.toString(8)} ${p}`);
      else ok(`${label} permissions are private`);
    }
  }
  const envNow = readEnv() || {};
  const rootsNow = String(envNow.BRIDGE_ALLOWED_ROOTS || "").split(",").map((r) => r.trim()).filter(Boolean);
  for (const p of rootProblems(rootsNow)) warn(p.msg);
  let envFiles = 0;
  const walk = (dir, depth) => {
    if (depth > 3 || envFiles > 50) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!/^(node_modules|\.git|\.venv|venv|__pycache__|dist|build)$/.test(e.name)) walk(path.join(dir, e.name), depth + 1); }
      else if (/^\.env(\.(?!example|sample|template)[\w.-]+)?$/.test(e.name)) {
        try { if (/^[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s#]{8,}/m.test(fs.readFileSync(path.join(dir, e.name), "utf8").slice(0, 20000))) envFiles++; } catch {}
      }
    }
  };
  for (const r of rootsNow) if (!inside(ROOT, r)) walk(r, 0);
  if (envFiles) warn(`${envFiles} .env file(s) with real-looking secrets inside your --roots: the agent can read them. Keep real secrets outside code folders (secret manager / shell environment) and commit only .env.example.`);
  // SEC-16: is the running OmniRoute the pinned one?
  if (dv.status === 0) {
    try {
      const pinned = composeImage(fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8"));
      const cid = dockerOut(["compose", "ps", "-q", "omniroute"]).stdout.trim();
      if (pinned && cid) {
        const running = dockerOut(["inspect", cid, "--format", "{{.Image}}"]).stdout.trim();
        const want = dockerOut(["image", "inspect", pinned, "--format", "{{.Id}}"]).stdout.trim();
        if (!want) info(`pinned OmniRoute image is not pulled yet (${pinned.split("@")[0]}); node ar.mjs up pulls it`);
        else (running === want ? ok : warn)(running === want ? `OmniRoute runs the pinned image (${pinned.split("@")[0]})` : "OmniRoute is not running the pinned image — recreate it: docker compose up -d --force-recreate omniroute");
      }
    } catch {}
  }
  // SEC-04: nothing may listen beyond loopback, and the gateway container must reach the host bridge
  try {
    const composeText = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    const exposed = [...composeText.matchAll(/^\s*-\s*"?(?!127\.0\.0\.1:)(\d+:\d+)"?\s*$/gm)].map((m) => m[1]);
    if (exposed.length) { bad(`docker-compose.yml publishes ${exposed.join(", ")} on all interfaces — prefix with 127.0.0.1:`); fatal++; }
    else ok("compose ports are bound to 127.0.0.1 only");
  } catch {}
  const bh = String((readEnv() || {}).BRIDGE_HOST || "127.0.0.1");
  if (["0.0.0.0", "::", "[::]"].includes(bh)) { bad(`BRIDGE_HOST=${bh} exposes the bridge to your network — use 127.0.0.1`); fatal++; }
  if (dv.status === 0 && (await portOpen(4000)) && (await portOpen(4100))) {
    const probe = spawnSync("docker", ["compose", "exec", "-T", "litellm", "python", "-c",
      "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://host.docker.internal:4100/healthz',timeout=5).status==200 else 1)"],
      { cwd: ROOT, encoding: "utf8" });
    (probe.status === 0 ? ok : warn)(probe.status === 0 ? "the gateway container reaches claude-bridge" : "the gateway container cannot reach claude-bridge (host.docker.internal:4100) — on Linux bind BRIDGE_HOST to the docker0 address");
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
// SEC-10: the agent can read and edit everything under --roots, so neither the gateway's own secrets nor a whole home may be there.
const realOr = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const inside = (child, parent) => { const c = realOr(child), r = realOr(parent); return c === r || c.startsWith(r + path.sep); };
export function rootProblems(roots, repo = ROOT, home = os.homedir()) {
  const out = [];
  for (const r of roots) {
    const real = realOr(r);
    if (real === realOr(home) || real === path.parse(real).root) out.push({ fatal: true, root: r, msg: `--roots ${r} is your whole home folder or the disk root: the agent could read every secret you own. Pick the folder where you keep code.` });
    else if (inside(repo, r)) out.push({ fatal: false, root: r, msg: `O auto-router está dentro de uma pasta que o agente pode ler/editar (${r}). Mova o auto-router para fora (ex.: ~/.local/share/auto-router) ou escolha outro --roots.` });
  }
  return out;
}
function init(flags) {
  const profile = String(flags.profile || "A").toUpperCase();
  const auto = profile === "AUTO";
  const pf = path.join(ROOT, "profiles", `routing.${auto ? "A" : profile}.yaml`);
  if (!fs.existsSync(pf)) { bad(`unknown profile ${profile} (use A-F or auto — see profiles/)`); process.exit(1); }
  const claude = String(flags.claude || "cli");
  if (!["cli", "api", "none"].includes(claude)) { bad("--claude must be cli, api or none"); process.exit(1); }
  const safetyFlag = String(flags.safety || "on").toLowerCase();
  if (!["on", "off"].includes(safetyFlag)) { bad("--safety must be on or off"); process.exit(1); }
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
  for (const p of rootProblems(roots)) {
    if (p.fatal) { bad(p.msg); process.exit(1); }
    if (flags["force-unsafe-roots"]) warn(p.msg + "  (continuing because of --force-unsafe-roots)");
    else { bad(p.msg); info("Only for a throwaway test: --force-unsafe-roots"); process.exit(1); }
  }

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
    t = setEnvText(t, "SAFETY_MODE", safetyFlag);
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
  // data/ stays 0755 on Linux: the container's root has no capabilities (cap_drop ALL) and could not write a 0700 folder owned by you
  fs.mkdirSync(DATA, { recursive: true, ...(process.platform === "linux" ? {} : { mode: 0o700 }) });
  fs.mkdirSync(HOME_CFG_DIR, { recursive: true, mode: 0o700 });
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

// ---------------------------------------------------------------- update
const REPO_DEFAULT = "so11on/auto-router";
// never overwritten, never deleted: secrets, runtime data, backups, VCS
const NEVER_TOUCH = [/^\.git\//, /^\.env$/, /^data\//, /^\.auto-router\//, /^node_modules\//, /\.bak/, /^\.DS_Store$/];
const MERGED = new Set(["litellm/routing.yaml", "litellm/config.yaml", "docker-compose.yml"]);
const posix = (p) => p.split(path.sep).join("/");
export function listFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name), rel = posix(path.relative(base, full));
    if (NEVER_TOUCH.some((re) => re.test(rel + (e.isDirectory() ? "/" : "")))) continue;
    if (e.isDirectory()) listFiles(full, base, out); else out.push(rel);
  }
  return out.sort();
}
const blockOf = (text, begin, end) => { const a = text.indexOf(begin), b = text.indexOf(end); return a >= 0 && b > a ? text.slice(a + begin.length + 1, b).replace(/\n$/, "") : null; };
/** New upstream config.yaml, with the locally managed blocks (openai / copilot models and fallbacks) carried over. */
/** SEC-16: `update` never changes which image runs. Upstream's compose is taken, but each service keeps the image line this
 *  install already pins. A floating tag (:latest, :main-stable, or no digest) is replaced by upstream's pinned line. */
export function mergeCompose(local, upstream) {
  const imageOf = (text) => {
    const out = {}; let svc = null;
    for (const line of text.split("\n")) {
      const s = line.match(/^  ([\w-]+):\s*$/); if (s) svc = s[1];
      const i = line.match(/^    image:\s*(\S+)/); if (i && svc) out[svc] = i[1];
    }
    return out;
  };
  const pinned = (ref) => /@sha256:[0-9a-f]{64}$/.test(ref) && !/:(latest|main-stable)(@|$)/.test(ref);
  const mine = imageOf(local); let svc = null;
  return upstream.split("\n").map((line) => {
    const s = line.match(/^  ([\w-]+):\s*$/); if (s) svc = s[1];
    return line.match(/^    image:\s*\S+/) && svc && mine[svc] && pinned(mine[svc]) ? line.replace(/image:\s*\S+/, `image: ${mine[svc]}`) : line;
  }).join("\n");
}
export function mergeConfig(local, upstream) {
  let out = upstream;
  for (const [b, e] of [[OPENAI_BEGIN, OPENAI_END], [FB_BEGIN, FB_END], [CP_BEGIN, CP_END], [CPF_BEGIN, CPF_END]]) {
    const body = blockOf(local, b, e);
    if (body && body.trim() && out.includes(b)) out = applyBlocks(out, b, e, body);
  }
  return out;
}
/** Keep the user's tuned routing.yaml; add what the new version introduced (new pins, new switching/context sections). */
export function mergeRouting(local, upstream) {
  let out = local;
  const pinNames = (t) => { const m = t.match(/(?:^|\n)pins:\n((?:  .*\n?)+)/); return m ? [...m[1].matchAll(/^  ([\w-]+):\s*\{.*\}.*$/gm)].map((x) => [x[1], x[0]]) : []; };
  const have = new Set(pinNames(out).map(([n]) => n));
  const missing = pinNames(upstream).filter(([n]) => !have.has(n));
  if (missing.length) {
    if (/(?:^|\n)pins:\n/.test(out)) out = out.replace(/((?:^|\n)pins:\n(?:  .*\n?)+)/, (m) => m.replace(/\n?$/, "\n") + missing.map(([, l]) => l).join("\n") + "\n");
    else out = out.replace(/\s*$/, "\n") + "\npins:\n" + missing.map(([, l]) => l).join("\n") + "\n";
  }
  for (const key of ["switching", "context"]) {
    if (new RegExp(`^${key}:`, "m").test(out)) continue;
    const m = upstream.match(new RegExp(`((?:^#.*\\n)*)^${key}:\\n(?:  .*\\n?)+`, "m"));
    if (m) out = out.replace(/\s*$/, "\n\n") + m[0].replace(/\n?$/, "\n");
  }
  return out;
}
/** Append variables introduced by the new .env.example with the example's default value and their comments. Never touches existing values. */
export function mergeEnv(localText, exampleText) {
  const have = new Set(Object.keys(parseEnv(localText)));
  const lines = exampleText.split(/\r?\n/), add = [], keys = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || have.has(m[1])) return;
    let j = i - 1; const com = [];
    while (j >= 0 && /^\s*#/.test(lines[j])) com.unshift(lines[j--]);
    add.push(...com, `${m[1]}=${l.slice(l.indexOf("=") + 1).trim()}`); // the example's own default: empty for secrets, a sane value for settings
    keys.push(m[1]);
  });
  return { text: keys.length ? localText.replace(/\s*$/, "\n") + "\n" + add.join("\n") + "\n" : localText, added: keys };
}
const semver = (v) => String(v || "0.0.0").trim().split(".").map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
export function changelogSince(text, version) {
  return text.split(/^## /m).slice(1).filter((blk) => newer(blk.match(/^(\d+\.\d+\.\d+)/)?.[1], version)).map((b) => "## " + b.trim()).join("\n\n");
}
/** Compare an unpacked upstream tree with this install. Pure file work, no network. */
export function planSync(upDir, localDir) {
  const plan = { add: [], change: [], same: 0, localOnly: [], merged: [], env: { added: [] }, texts: {} };
  const up = listFiles(upDir);
  for (const rel of up) {
    const src = path.join(upDir, rel), dst = path.join(localDir, rel);
    if (MERGED.has(rel)) {
      const upText = fs.readFileSync(src, "utf8"), locText = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : null;
      const merged = locText === null ? upText : rel.endsWith("routing.yaml") ? mergeRouting(locText, upText)
        : rel === "docker-compose.yml" ? mergeCompose(locText, upText) : mergeConfig(locText, upText);
      plan.texts[rel] = merged;
      if (locText === null) plan.add.push(rel); else if (merged !== locText) { plan.change.push(rel); plan.merged.push(rel); } else plan.same++;
    } else if (!fs.existsSync(dst)) plan.add.push(rel);
    else if (fs.readFileSync(src).equals(fs.readFileSync(dst))) plan.same++;
    else plan.change.push(rel);
  }
  const upSet = new Set(up);
  plan.localOnly = listFiles(localDir).filter((r) => !upSet.has(r));
  const envPath = path.join(localDir, ".env"), exPath = path.join(upDir, ".env.example");
  if (fs.existsSync(envPath) && fs.existsSync(exPath)) {
    const m = mergeEnv(fs.readFileSync(envPath, "utf8"), fs.readFileSync(exPath, "utf8"));
    plan.env = m; plan.texts[".env"] = m.text;
  }
  return plan;
}
export function applySync(plan, upDir, localDir, backupDir) {
  const save = (rel) => { const f = path.join(localDir, rel); if (fs.existsSync(f)) { const b = path.join(backupDir, rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(f, b); } };
  for (const rel of [...plan.add, ...plan.change]) {
    save(rel);
    const dst = path.join(localDir, rel); fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (rel in plan.texts) fs.writeFileSync(dst, plan.texts[rel]); else fs.copyFileSync(path.join(upDir, rel), dst);
  }
  if (plan.env.added.length) { save(".env"); fs.writeFileSync(path.join(localDir, ".env"), plan.texts[".env"], { mode: 0o600 }); }
}
async function fetchUpstream(repo, ref) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-update-"));
  const tgz = path.join(tmp, "src.tar.gz");
  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/refs/heads/${ref}`, { redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${repo}@${ref}`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  const x = run("tar", ["-xzf", tgz, "-C", tmp]);
  if (x.status !== 0) throw new Error(`could not unpack the download (is \`tar\` available?): ${(x.stderr || "").slice(0, 120)}`);
  const dir = fs.readdirSync(tmp, { withFileTypes: true }).find((d) => d.isDirectory());
  if (!dir) throw new Error("unexpected archive layout");
  return path.join(tmp, dir.name);
}
async function update(flags) {
  const repo = String(flags.repo || REPO_DEFAULT), ref = String(flags.ref || "main");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return bad("--repo must look like owner/name");
  let up;
  try { up = flags.from ? path.resolve(String(flags.from)) : await fetchUpstream(repo, ref); } catch (err) { return bad(err.message); }
  const readVer = (d) => { try { return fs.readFileSync(path.join(d, "VERSION"), "utf8").trim(); } catch { return null; } };
  const localV = readVer(ROOT) || "0.0.0 (before versioning)", upV = readVer(up) || "unknown";
  console.log(`Installed: ${localV}   Latest (${flags.from ? "local folder" : repo + "@" + ref}): ${upV}\n`);
  const plan = planSync(up, ROOT);
  const total = plan.add.length + plan.change.length + plan.env.added.length;
  if (!total) { ok("already up to date — nothing to change"); return; }
  const log = (title, list) => { if (list.length) { console.log(`${title} (${list.length}):`); list.forEach((f) => info(f)); } };
  log("New files", plan.add);
  log("Files that will be replaced", plan.change.filter((f) => !plan.merged.includes(f)));
  log("Files merged with your settings (your choices are kept)", plan.merged);
  if (plan.env.added.length) { console.log(`New settings added to .env with their default (${plan.env.added.length}):`); plan.env.added.forEach((k) => info(k)); }
  if (plan.localOnly.length) info(`${plan.localOnly.length} file(s) exist only on this computer and are left alone.`);
  console.log("\nNever touched: .env values, data/, litellm/routing.yaml tuning, keys, backups.");
  try { const log2 = fs.readFileSync(path.join(up, "CHANGELOG.md"), "utf8"); const w = changelogSince(log2, readVer(ROOT) || "0.0.0"); if (w) console.log(`\nWhat's new since ${localV}:\n\n${w}\n`); } catch {}
  if (!flags.apply) { warn("dry run — nothing was changed. To apply: node ar.mjs update --apply   (add --restart to restart the stack)"); return; }
  const backup = path.join(DATA, `update-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  applySync(plan, up, ROOT, backup);
  ok(`updated to ${upV}. Replaced files were saved in ${path.relative(ROOT, backup)}`);
  const changed = [...plan.add, ...plan.change];
  const touches = (re) => changed.some((f) => re.test(f));
  const todo = [];
  if (touches(/^(litellm\/|docker-compose\.yml|claude-bridge\/)/)) todo.push("restart the stack:  node ar.mjs down && node ar.mjs up");
  if (touches(/^vscode-extension\//)) todo.push("refresh VS Code (extension + models):  node ar.mjs vscode   then Developer: Reload Window");
  todo.push("see what this computer can use now:  node ar.mjs detect   (new: paid GitHub Copilot → node ar.mjs copilot ; ChatGPT → node ar.mjs openai)");
  todo.push("check:  node ar.mjs smoke");
  if (flags.restart) { await down(); await up({}); todo.shift(); }
  console.log("\nNext steps:"); todo.forEach((t) => info(t));
  if (fs.existsSync(path.join(ROOT, ".git"))) info("This folder is a git clone: files were updated in place. Realign git with: git fetch && git reset --mixed origin/main");
}

// ---------------------------------------------------------------- safety
async function safety(flags, rest) {
  const e = readEnv();
  if (!e) return bad("no .env — run: node ar.mjs init");
  const arg = (rest[1] || "status").toLowerCase();
  if (!["on", "off", "status"].includes(arg)) return bad("usage: node ar.mjs safety [on|off|status]");
  if (arg !== "status") {
    setEnv("SAFETY_MODE", arg);
    ok(`SAFETY_MODE=${arg}`);
    if (arg === "off") warn("models that may log, train on or let humans read your prompts are allowed again (free Gemini key, LLM7, OpenRouter :free, NVIDIA trial, Mistral free)");
    const r = spawnSync("docker", ["compose", "up", "-d", "--force-recreate", "litellm"], { cwd: ROOT, stdio: "ignore" });
    (r.status === 0 ? ok : warn)(r.status === 0 ? "gateway recreated with the new setting" : "could not recreate the gateway: run  docker compose up -d --force-recreate litellm");
  }
  const cur = readEnv();
  console.log(`safety mode: ${cur.SAFETY_MODE || "on"}   sensitive guard: ${cur.SENSITIVE_GUARD || "on"}   allowed for sensitive content: ${cur.SENSITIVE_ALLOWED_CLASSES || "trusted"}   mask secrets: ${cur.SENSITIVE_MASK_SECRETS || "on"}   mask personal data: ${cur.SENSITIVE_MASK_PII || "off"}`);
  if ((cur.SAFETY_MODE || "on") === "on" && cur.GEMINI_FREE_API_KEY) info("GEMINI_FREE_API_KEY is set but ignored while safety is on (free-tier Gemini may be read by humans and used to improve products). You can leave it empty.");
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
  const env0 = readEnv() || {};
  info(`safety: ${env0.SAFETY_MODE || "on"} · sensitive guard: ${env0.SENSITIVE_GUARD || "on"}`);
  const g = await http(`${GATEWAY}/health/liveliness`, { timeout: 3000 });
  (g.status === 200 ? ok : bad)(`gateway :4000 ${g.status === 200 ? "up" : "down"}`);
  (await portOpen(20128) ? ok : bad)("OmniRoute :20128 " + ((await portOpen(20128)) ? "up" : "down"));
  const b = await http(`${BRIDGE}/healthz`, { timeout: 2000 });
  (b.status === 200 ? ok : warn)(`claude-bridge :4100 ${b.status === 200 ? "up" : "down (only needed for the Claude CLI route)"}`);
  try {
    const mine = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
    const r = await http(`https://raw.githubusercontent.com/${REPO_DEFAULT}/main/VERSION`, { timeout: 3000 });
    if (r.status === 200 && newer(r.text.trim(), mine)) warn(`a newer version is available (${mine} → ${r.text.trim()}): node ar.mjs update`);
  } catch {}
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

  // SEC-09: with SAFETY_MODE=on only models whose class is not `unsafe` are registered or probed
  const safe = String(e.SAFETY_MODE || "on").toLowerCase() !== "off";
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "profiles", "pool-models.json"), "utf8"));
  for (const combo of ["free-fast", "free-coding"]) spec[combo] = (spec[combo] || []).map((x) => (typeof x === "string" ? { id: x, privacy: "unsafe" } : x));
  const usable = (m) => !(safe && m.privacy === "unsafe") && !(flags["no-llm7"] && m.id.startsWith("llm7/"));
  const providersWithModels = new Set(["free-fast", "free-coding"].flatMap((c) => spec[c].filter(usable).map((m) => m.id.split("/")[0])));
  const want = PROVIDERS.filter(([k, id]) => e[k] && providersWithModels.has(id)).map(([k, id]) => [id, e[k]]);
  if (cfOk) want.push(["cloudflare-ai", e.CLOUDFLARE_API_TOKEN]);
  if (providersWithModels.has("llm7")) want.push(["llm7", "unused"]);
  if (safe) {
    const skipped = PROVIDERS.filter(([k, id]) => e[k] && !providersWithModels.has(id)).map(([, id]) => id);
    if (skipped.length) info(`SAFETY_MODE=on: ${skipped.join(", ")} skipped (their free models may log or train on prompts). Use \`node ar.mjs safety off\` to include them.`);
    if (e.GEMINI_FREE_API_KEY) info("SAFETY_MODE=on: GEMINI_FREE_API_KEY is not used (the free Gemini tier may train on prompts); it can stay empty.");
  }
  if (!want.length) return bad("no usable provider keys in .env yet — add keys (Groq, Ollama Cloud, Cloudflare), then rerun");
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
  if (cfOk && connIds["cloudflare-ai"]) { // Workers AI model ids are discovered, then verified like all others
    const list = (await api(`/api/providers/${connIds["cloudflare-ai"]}/models`)).json?.models || [];
    const prefs = [/llama-3\.3-70b/, /gpt-oss-120b/, /gpt-oss-20b/, /glm-4\.7/, /gemma-4/, /qwen.*coder/];
    const picked = [];
    for (const re of prefs) { const m = list.find((x) => re.test(x.id) && !picked.includes(x.id)); if (m) picked.push(m.id); }
    for (const id of picked.slice(0, 4)) for (const c of ["free-coding", "free-fast"]) spec[c].push({ id: `cloudflare-ai/${id}`, privacy: "no_retention" });
    info(`Cloudflare Workers AI candidates: ${picked.slice(0, 4).join(", ") || "none found"}`);
  }
  const bearer = { authorization: `Bearer ${poolKey}` };
  const good = { "free-fast": [], "free-coding": [] };
  const probed = new Map();
  for (const combo of Object.keys(good)) {
    for (const entry of (spec[combo] || []).filter(usable)) {
      const model = entry.id;
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
      if (probed.get(model) === "ok") good[combo].push(entry);
    }
  }
  for (const [model, res] of probed) (res === "ok" ? ok : warn)(`${model}: ${res === "ok" ? "answers" : "dropped (" + res + ")"}`);

  const combos = (await api("/api/combos")).json?.combos || [];
  let usableCombos = 0;
  for (const [name, entries] of Object.entries(good)) {
    const models = entries.map((x) => x.id);
    if (!models.length) { warn(`combo ${name}: no working model — skipped`); continue; }
    usableCombos++;
    const ex = combos.find((x) => x.name === name);
    const r = ex ? await api(`/api/combos/${ex.id}`, { method: "PUT", body: { models } })
                 : await api("/api/combos", { method: "POST", body: { name, strategy: "priority", models } });
    (r.status < 300 ? ok : bad)(`combo ${name}: ${models.length} models${r.status < 300 ? "" : " (" + r.text.slice(0, 80) + ")"}`);
  }
  // classes of the members that really answer: the gateway derives the privacy of free-pool* from this file
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "pool-members.json"), JSON.stringify(good, null, 2) + "\n");
  ok(`wrote data/pool-members.json (${Object.values(good).flat().length} members, none "unsafe": ${!Object.values(good).flat().some((x) => x.privacy === "unsafe") || !safe})`);
  if (usableCombos === 2) { setEnv("FREE_POOL_ENABLED", "true"); ok("FREE_POOL_ENABLED=true"); }
  else warn("both combos need at least one working model; FREE_POOL_ENABLED left as is");
  info("Apply to the gateway: docker compose up -d --force-recreate litellm");
}

// ---------------------------------------------------------------- omniroute: contract check and safe upgrade (SEC-16)
const COMPOSE_FILE = path.join(ROOT, "docker-compose.yml");
const OMNI_REPO = "diegosouzapw/omniroute";
export function composeImage(text, service = "omniroute") {
  let svc = null;
  for (const line of text.split("\n")) {
    const s = line.match(/^  ([\w-]+):\s*$/); if (s) svc = s[1];
    const i = line.match(/^    image:\s*(\S+)/); if (i && svc === service) return i[1];
  }
  return null;
}
export function setComposeImage(text, service, ref) {
  let svc = null;
  return text.split("\n").map((line) => {
    const s = line.match(/^  ([\w-]+):\s*$/); if (s) svc = s[1];
    return svc === service && /^    image:\s*\S+/.test(line) ? `    image: ${ref}` : line;
  }).join("\n");
}
async function contractReport(base, password, key, chat) {
  const { runContract, failed } = await import("./scripts/omniroute-contract.mjs");
  const res = await runContract({ base, password, key, chat });
  for (const r of res) (r.ok ? ok : r.required ? bad : warn)(`${r.name}${r.detail ? "  — " + r.detail : ""}`);
  return failed(res).length === 0;
}
async function omnirouteCheck() {
  const e = readEnv();
  if (!e?.OMNIROUTE_PASSWORD) return bad("no .env / OMNIROUTE_PASSWORD — run: node ar.mjs init");
  if (!(await portOpen(20128))) return bad("OmniRoute is not running — run: node ar.mjs up");
  const good = await contractReport(OMNI, e.OMNIROUTE_PASSWORD, e.FREE_POOL_KEY || null, e.FREE_POOL_KEY ? "free-fast" : null);
  process.exitCode = good ? 0 : 1;
  (good ? ok : bad)(good ? "OmniRoute honours the contract the gateway depends on" : "OmniRoute does not honour the contract — see docs/OMNIROUTE-CONTRACT.md before using the free pool");
}
const dockerOut = (args) => spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
async function omnirouteUpgrade(flags) {
  const compose0 = fs.readFileSync(COMPOSE_FILE, "utf8");
  const current = composeImage(compose0);
  if (!current) return bad("could not find the omniroute image line in docker-compose.yml");
  const to = flags.to && flags.to !== true ? String(flags.to) : null;
  if (!to && !flags.rollback) {
    info(`pinned now: ${current}`);
    try {
      const r = await http(`https://hub.docker.com/v2/repositories/${OMNI_REPO}/tags?page_size=15&ordering=last_updated`, { timeout: 15000 });
      const names = (r.json?.results || []).map((x) => x.name);
      info(`recent tags: ${names.join(", ") || "(could not list)"}`);
    } catch { warn("could not reach Docker Hub to list tags"); }
    info("to test and switch:  node ar.mjs omniroute-upgrade --to <tag>   (add --dry-run to only test)   ·   undo:  --rollback");
    return;
  }
  const backups = path.join(DATA, "backups");
  const volumeOf = () => {
    const id = dockerOut(["compose", "ps", "-q", "omniroute"]).stdout.trim();
    if (!id) return null;
    const m = JSON.parse(dockerOut(["inspect", id, "--format", "{{json .Mounts}}"]).stdout || "[]").find((x) => x.Destination === "/app/data");
    return m?.Name || null;
  };
  const lastGood = path.join(DATA, "omniroute-last-good.json");
  const recreate = async () => {
    const r = spawnSync("docker", ["compose", "up", "-d", "--force-recreate", "omniroute"], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 40 && !(await portOpen(20128)); i++) await sleep(1500);
    await sleep(5000);
    spawnSync("docker", ["compose", "up", "-d", "litellm"], { cwd: ROOT, stdio: "ignore" }); // stopping omniroute also stopped the gateway
    return r.status === 0;
  };

  if (flags.rollback) {
    if (!fs.existsSync(lastGood)) return bad("nothing to roll back: data/omniroute-last-good.json does not exist");
    const lg = JSON.parse(fs.readFileSync(lastGood, "utf8"));
    fs.writeFileSync(COMPOSE_FILE, setComposeImage(compose0, "omniroute", lg.image));
    const vol = volumeOf();
    if (lg.backup && fs.existsSync(lg.backup) && vol) {
      spawnSync("docker", ["compose", "stop", "omniroute"], { cwd: ROOT, stdio: "ignore" });
      const rr = dockerOut(["run", "--rm", "--entrypoint", "sh", "-v", `${vol}:/data`, "-v", `${path.dirname(lg.backup)}:/backup:ro`, lg.image, "-c", `rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xf /backup/${path.basename(lg.backup)} -C /data`]);
      (rr.status === 0 ? ok : warn)(rr.status === 0 ? "restored the OmniRoute data volume from the backup" : "could not restore the volume: " + (rr.stderr || "").slice(0, 120));
    } else warn("no volume backup to restore; only the image is rolled back");
    (await recreate()) ? ok(`OmniRoute is back on ${lg.image}`) : bad("could not recreate OmniRoute — run: docker compose up -d omniroute");
    return;
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(to)) return bad("--to must be an image tag such as 3.9.0");
  const candidate = `${OMNI_REPO}:${to}`;
  info(`candidate ${candidate}; nothing is changed unless every step passes`);
  const pull = dockerOut(["pull", candidate]);
  if (pull.status !== 0) return bad(`could not pull ${candidate}: ${(pull.stderr || "").trim().split("\n").pop()}`);
  const digest = dockerOut(["image", "inspect", candidate, "--format", "{{index .RepoDigests 0}}"]).stdout.trim().split("@")[1];
  if (!/^sha256:[0-9a-f]{64}$/.test(digest || "")) return bad("could not read the candidate's digest");
  const ref = `${candidate}@${digest}`;
  const port = 20129, name = "ar-omniroute-candidate", pw = crypto.randomBytes(12).toString("hex");
  dockerOut(["rm", "-f", name]);
  const started = dockerOut(["run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:20128`, "-e", "REQUIRE_API_KEY=true", "-e", `INITIAL_PASSWORD=${pw}`, ref]);
  if (started.status !== 0) return bad(`could not start the candidate: ${(started.stderr || "").trim().slice(0, 160)}`);
  let passed = false;
  try {
    for (let i = 0; i < 40 && !(await portOpen(port)); i++) await sleep(1500);
    await sleep(6000);
    info("running the contract against the candidate (fresh data, no providers, no real prompts)");
    passed = await contractReport(`http://127.0.0.1:${port}`, pw, null, null);
  } finally { dockerOut(["rm", "-f", name]); }
  if (!passed) return bad("the candidate does not honour the contract — nothing was changed");
  ok("candidate passes the contract");
  if (flags["dry-run"]) { info(`dry run: would pin ${ref}`); return; }

  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const vol = volumeOf();
  const backup = path.join(backups, `omniroute-${new Date().toISOString().replace(/[:.]/g, "-")}.tar`);
  if (vol) {
    const b = dockerOut(["run", "--rm", "--entrypoint", "sh", "-v", `${vol}:/data:ro`, "-v", `${backups}:/backup`, current, "-c", `tar cf /backup/${path.basename(backup)} -C /data .`]);
    if (b.status !== 0) return bad("could not back up the OmniRoute data volume — nothing was changed: " + (b.stderr || "").slice(0, 120));
    fs.chmodSync(backup, 0o600); ok(`backed up the data volume → ${path.relative(ROOT, backup)}`);
  } else warn("no running OmniRoute volume found; continuing without a data backup");
  fs.writeFileSync(lastGood, JSON.stringify({ image: current, backup: vol ? backup : null, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.writeFileSync(COMPOSE_FILE, setComposeImage(compose0, "omniroute", ref));
  const revert = async (why) => { fs.writeFileSync(COMPOSE_FILE, compose0); await recreate(); bad(`${why} — reverted to ${current}`); };
  if (!(await recreate())) return revert("could not start the new OmniRoute");
  const e = readEnv() || {};
  if (!(await contractReport(OMNI, e.OMNIROUTE_PASSWORD, e.FREE_POOL_KEY || null, e.FREE_POOL_KEY ? "free-fast" : null))) return revert("the contract failed on the running instance");
  ok(`OmniRoute pinned to ${ref}. Run: node ar.mjs omniroute   (re-verify the pool)   then   node ar.mjs smoke`);
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
// SEC-12: optional VS Code hardening. Only these keys, never global auto-approve / Autopilot / Bypass.
// `chat.agent.sandbox.enabled` is the name VS Code 1.142 ships (checked 2026-10-25 in its workbench bundle); `chat.tools.terminal.sandbox.enabled`
// from the docs is not in that build, so it is not written. chat.agent.networkFilter may be managed by an organisation: documented, not written.
export const HARDEN_AUTOAPPROVE = { "**/.env": false, "**/.env.*": false, "**/*.pem": false, "**/*.key": false, "**/.vscode/*.json": false, "**/secrets/**": false };
/** Returns { text, added, kept }. `state.added` (from the previous run) is what `remove` takes out again; nothing else is touched. */
export function patchHarden(text, state = {}, { remove = false, sandbox = true } = {}) {
  let cfg = {};
  if (text.trim()) {
    try { cfg = JSON.parse(text); } catch { throw new Error("settings.json has comments or trailing commas; edit it by hand using docs/VSCODE-SETUP.md (a script would drop your comments)"); }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("settings.json is not a JSON object");
  }
  const prev = state.added || { autoApprove: [], sandbox: false };
  const added = { autoApprove: [], sandbox: false }, kept = [];
  const aa = { ...(cfg["chat.tools.edits.autoApprove"] || {}) };
  if (remove) {
    for (const k of prev.autoApprove || []) delete aa[k];
    if (Object.keys(aa).length) cfg["chat.tools.edits.autoApprove"] = aa; else delete cfg["chat.tools.edits.autoApprove"];
    if (prev.sandbox) delete cfg["chat.agent.sandbox.enabled"];
    return { text: JSON.stringify(cfg, null, 2) + "\n", added: { autoApprove: [], sandbox: false }, kept };
  }
  for (const [k, v] of Object.entries(HARDEN_AUTOAPPROVE)) {
    if (k in aa) { if (aa[k] !== v) kept.push(k); if ((prev.autoApprove || []).includes(k)) added.autoApprove.push(k); }
    else { aa[k] = v; added.autoApprove.push(k); }
  }
  cfg["chat.tools.edits.autoApprove"] = aa;
  if (sandbox) {
    if ("chat.agent.sandbox.enabled" in cfg) { if (cfg["chat.agent.sandbox.enabled"] !== true) kept.push("chat.agent.sandbox.enabled"); added.sandbox = Boolean(prev.sandbox); }
    else { cfg["chat.agent.sandbox.enabled"] = true; added.sandbox = true; }
  }
  return { text: JSON.stringify(cfg, null, 2) + "\n", added, kept };
}
function vscodeHarden(flags) {
  const dir = flags.dir ? path.resolve(String(flags.dir)) : vscodeUserDir(flags.insiders ? "Code - Insiders" : "Code");
  const file = path.join(dir, "settings.json"), stateFile = path.join(HOME_CFG_DIR, "harden-added.json");
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
  const sandbox = process.platform !== "win32";
  let r;
  try { r = patchHarden(old, state, { remove: Boolean(flags.uninstall), sandbox }); } catch (err) { return bad(err.message); }
  if (old) fs.writeFileSync(file + ".bak-auto-router", old, { mode: 0o600 });
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, r.text);
  fs.mkdirSync(HOME_CFG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify({ added: r.added }), { mode: 0o600 });
  ok(flags.uninstall ? `removed only what auto-router added from ${file}` : `hardened ${file} (backup: .bak-auto-router): edits to .env/keys/secrets/.vscode need your approval${sandbox ? ", terminal sandbox on" : ""}`);
  if (r.kept.length) info(`kept your own values for: ${r.kept.join(", ")}`);
  if (!sandbox && !flags.uninstall) info("terminal sandbox skipped: it does not exist on Windows (use WSL2)");
  if (!flags.uninstall) info("Not touched: global auto-approve, Autopilot, bypass. chat.agent.networkFilter may be managed by your organisation (see docs/VSCODE-SETUP.md).");
}
function vscode(flags) {
  if (flags.harden) return vscodeHarden(flags);
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
  init        --roots <folders> [--safety on|off] [--profile A-F|auto] [--families claude,openai,copilot,gemini] [--pool yes|no] [--claude cli|api|none] [--openai cli|api|none] [--force]
  keys        [--check] show which keys are set; --check tests each one against its provider
  cloudflare-token   fix "Authentication error" when CLOUDFLARE_API_TOKEN is a 'create tokens' token (docs/GET-KEYS.md)
  update      [--apply] [--restart] [--repo owner/name] [--ref branch] [--from <folder>]   dry run by default; --apply changes files (backup kept)
  safety      [on|off|status]   SAFETY_MODE (privacy classes) and the sensitive-data guard
  detect      [--json]  find out which paid plans/logins exist (never prints e-mails or keys)
  copilot     [--mini ID --main ID --max ID] [--check]   use your paid GitHub Copilot plan (Copilot CLI)
  openai      [--list] [--route cli|api|both] [--mini ID --main ID --max ID] [--check]   OpenAI via ChatGPT login (Codex CLI) and/or API key
  up | down | status
  omniroute   [--no-llm7] [--check]   connect free providers, verify models, build the combos; --check tests the OmniRoute contract
  omniroute-upgrade   [--to <tag> [--dry-run]] [--rollback]   list tags / test a new OmniRoute on a spare port and switch only if it passes
  vscode      [--uninstall] [--insiders] [--dir <path>] [--harden]   --harden: optional safer VS Code settings (backs up settings.json)
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
    case "safety": return safety(flags, rest);
    case "update": return update(flags);
    case "copilot": return copilot(flags);
    case "cloudflare-token": return cloudflareToken();
    case "up": return up(flags);
    case "down": return down();
    case "status": return status();
    case "omniroute": return flags.check ? omnirouteCheck() : omniroute(flags);
    case "omniroute-upgrade": return omnirouteUpgrade(flags);
    case "vscode": return vscode(flags);
    case "smoke": return smoke();
    case "logs": return logs(flags);
    case "usage": return usage(flags);
    default: console.log(HELP); process.exitCode = cmd ? 1 : 0;
  }
}
const realArgv = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return ""; } })();
if (realArgv && realArgv === fs.realpathSync(fileURLToPath(import.meta.url))) await main();
