#!/usr/bin/env node
// auto-router control script. Node >= 18, no dependencies, works on Windows, macOS and Linux.
//
//   node ar.mjs doctor                  check Docker / Node / Claude CLI / VS Code and ports
//   node ar.mjs init [options]          create .env (generated secrets), pick a routing profile, remember paths
//   node ar.mjs keys                    which keys are set (names only, never values)
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
  GEMINI_API_KEY: "Google AI Studio (project WITH billing): https://aistudio.google.com/apikey",
  GEMINI_FREE_API_KEY: "Google AI Studio → 'Create API key in new project' (NO billing): https://aistudio.google.com/apikey",
  ANTHROPIC_API_KEY: "Anthropic Console → Plans & Billing (credits) then API Keys: https://console.anthropic.com",
  GROQ_API_KEY: "https://console.groq.com/keys",
  OPENROUTER_API_KEY: "https://openrouter.ai/keys",
  MISTRAL_API_KEY: "https://console.mistral.ai/api-keys",
  OLLAMA_API_KEY: "https://ollama.com/settings/keys",
  NVIDIA_API_KEY: "https://build.nvidia.com (free NVIDIA Developer Program)",
};
function init(flags) {
  const profile = String(flags.profile || "A").toUpperCase();
  const pf = path.join(ROOT, "profiles", `routing.${profile}.yaml`);
  if (!fs.existsSync(pf)) { bad(`unknown profile ${profile} (use A, B, C or D — see profiles/)`); process.exit(1); }
  const claude = String(flags.claude || "cli");
  if (!["cli", "api", "none"].includes(claude)) { bad("--claude must be cli, api or none"); process.exit(1); }
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
    if (profile === "C" || profile === "D") t = setEnvText(t, "CLASSIFIER_MODEL", "pool");
    fs.writeFileSync(ENV_FILE, t, { mode: 0o600 });
    ok("created .env with generated secrets (permissions restricted)");
  }
  // routing profile
  const target = path.join(ROOT, "litellm", "routing.yaml");
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== fs.readFileSync(pf, "utf8")) fs.copyFileSync(target, target + ".bak");
  fs.copyFileSync(pf, target);
  ok(`routing profile ${profile} → litellm/routing.yaml`);
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(HOME_CFG_DIR, { recursive: true });
  fs.writeFileSync(path.join(HOME_CFG_DIR, "config.json"), JSON.stringify({ repo: ROOT, stateFile: path.join(DATA, "context-state.json") }, null, 2));
  ok(`remembered this folder in ${path.join(HOME_CFG_DIR, "config.json")} (used by the VS Code extension)`);

  console.log("\nNext: put the keys you have into .env (leave the others empty). Where to get them:");
  for (const [k, v] of Object.entries(KEY_LINKS)) info(`${k.padEnd(20)} ${v}`);
  info("Claude subscription: nothing to create — just be logged in to the `claude` CLI.");
  console.log("\nThen: node ar.mjs up   →   node ar.mjs omniroute   →   node ar.mjs vscode   →   node ar.mjs smoke");
}

function keys() {
  const e = readEnv();
  if (!e) return bad("no .env — run: node ar.mjs init");
  const names = Object.keys(KEY_LINKS).concat(["CLOUDFLARE_API_TOKEN"]);
  for (const k of names) console.log(`${(e[k] ? c(32, "set  ") : c(90, "empty"))}  ${k}`);
  info(`CLAUDE_PRIMARY=${e.CLAUDE_PRIMARY}  FREE_POOL_ENABLED=${e.FREE_POOL_ENABLED}  CLASSIFIER_MODEL=${e.CLASSIFIER_MODEL}`);
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
  init        --roots <folders> [--profile A|B|C|D] [--claude cli|api|none] [--force]
  keys        show which keys are set
  up | down | status
  omniroute   [--no-llm7]   connect free providers, verify models, build the combos
  vscode      [--uninstall] [--insiders] [--dir <path>]
  smoke       one request per profile
  logs        [-f] [--errors] [--tail N] [--type T] [--rid ID] [--since 30m] [--raw]
  usage       [--since 24h|7d|all] [--by model|mode|task]

Profiles: A Claude + billed Gemini + free pool | B Gemini only | C Claude + free pool | D free only`;

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0];
  switch (cmd) {
    case "doctor": return doctor();
    case "init": return init(flags);
    case "keys": return keys();
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
