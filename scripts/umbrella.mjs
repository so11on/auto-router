// The auto-router umbrella: ONE switch for everything it installs, and one switch per feature.
//
//   node ar.mjs on | off                 all of it / none of it (off always returns Claude Code to Anthropic directly)
//   node ar.mjs feature list             what each feature is, wanted vs actually installed
//   node ar.mjs feature <name> on|off    one feature
//
// What a person WANTS is data: gateway/features.defaults.json (everything off, committed) overlaid by config/local/features.json
// (yours, git-ignored). What is INSTALLED is checked on the machine itself. Everything installed under ~/.claude is recognisable
// as ours (a path under ~/.auto-router, or markers in a file) and removing a feature touches nothing else: your own hooks, skills,
// permissions and CLAUDE.md text stay exactly as they are. Settings are backed up once a day before the first change.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GATEWAY_URL = "http://127.0.0.1:4001";
export const MD_BEGIN = (n) => `<!-- auto-router:begin ${n} -->`;
export const MD_END = (n) => `<!-- auto-router:end ${n} -->`;

// order matters: dependencies first when turning on, last when turning off
export const ORDER = ["gateway", "claude_code", "gemini_tools", "token_hooks", "haiku_subagents", "compact_instructions", "terse_style",
  "statusline", "vscode_status", "resume_on_reset", "notifications", "legacy_stack"];

export const DESCRIPTIONS = {
  gateway: "the local gateway service on 127.0.0.1:4001 (starts at login, restarts on failure)",
  claude_code: "point Claude Code at the gateway (settings.json env); off = straight to Anthropic",
  gemini_tools: "Gemini as a command the Claude calls to read big things cheaply (skill + permission)",
  token_hooks: "hook that cuts test-runner output to failures and the last lines",
  haiku_subagents: "a Haiku subagent for tests, builds and long logs, so their output stays out of the main context",
  compact_instructions: "tells /compact what to keep (block in ~/.claude/CLAUDE.md)",
  terse_style: "the optional terse output style (the 'caveman' idea; saves little, see docs/TOKEN-SAVING.md)",
  statusline: "status line: model (effort), context, plan use (never replaces a status line of yours)",
  vscode_status: "VS Code status bar: model (effort) and plan use, plus the Add to Claude Code menu",
  resume_on_reset: "when the plan runs out, offer to wait and resume the session by itself after the reset",
  notifications: "desktop notifications from the gateway",
  legacy_stack: "the earlier LiteLLM + OmniRoute + bridge stack for Copilot Chat (needs Docker)",
};

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const today = () => new Date().toISOString().slice(0, 10);

export function createUmbrella({ root, home = os.homedir(), actions = {}, say = () => {} }) {
  const defaultsFile = path.join(root, "gateway", "features.defaults.json");
  const localFile = path.join(root, "config", "local", "features.json");
  const cdir = path.join(home, ".claude");
  const settingsFile = path.join(cdir, "settings.json");
  const arDir = path.join(home, ".auto-router");
  const tpl = (...p) => path.join(root, "templates", "claude-code", ...p);

  // ---------------------------------------------------------------- wanted state
  function wanted() {
    const d = readJson(defaultsFile, { enabled: false, features: {} });
    const l = readJson(localFile, {});
    return { enabled: l.enabled ?? d.enabled ?? false, features: { ...(d.features || {}), ...(l.features || {}) } };
  }
  function saveLocal(patch) {
    const l = readJson(localFile, {});
    const next = { ...l, ...patch, features: { ...(l.features || {}), ...(patch.features || {}) } };
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    fs.writeFileSync(localFile, JSON.stringify(next, null, 2) + "\n");
  }

  // ---------------------------------------------------------------- ~/.claude/settings.json
  const readSettings = () => { if (!fs.existsSync(settingsFile)) return {}; return JSON.parse(fs.readFileSync(settingsFile, "utf8")); };
  function writeSettings(s) {
    fs.mkdirSync(cdir, { recursive: true });
    const backup = `${settingsFile}.bak-auto-router-${today()}`;
    if (fs.existsSync(settingsFile) && !fs.existsSync(backup)) fs.copyFileSync(settingsFile, backup);
    const tmp = settingsFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, settingsFile);
  }
  const edit = (fn) => { const s = readSettings(); fn(s); writeSettings(s); };
  const ours = (cmd) => typeof cmd === "string" && cmd.includes(arDir);
  const hasOurHook = (s, event) => ((s.hooks || {})[event] || []).some((e) => (e.hooks || []).some((h) => ours(h.command)));
  function removeHooks(s, event) {
    if (!s.hooks || !s.hooks[event]) return;
    s.hooks[event] = s.hooks[event].map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !ours(h.command)) })).filter((e) => e.hooks.length);
    if (!s.hooks[event].length) delete s.hooks[event];
    if (!Object.keys(s.hooks).length) delete s.hooks;
  }
  const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

  // markers inside a file the person may also edit (CLAUDE.md)
  function mdPut(file, name, body) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const block = `${MD_BEGIN(name)}\n${body.trim()}\n${MD_END(name)}\n`;
    const re = new RegExp(`${MD_BEGIN(name)}[\\s\\S]*?${MD_END(name)}\\n?`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, re.test(cur) ? cur.replace(re, block) : (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + (cur ? "\n" : "") + block);
  }
  function mdDrop(file, name) {
    if (!fs.existsSync(file)) return;
    const cur = fs.readFileSync(file, "utf8");
    const next = cur.replace(new RegExp(`${MD_BEGIN(name)}[\\s\\S]*?${MD_END(name)}\\n?`), "").replace(/\n{3,}/g, "\n\n").replace(/\n\n$/, "\n");
    if (next.trim()) fs.writeFileSync(file, next.replace(/^\n+/, "")); else rm(file);
  }
  const mdHas = (file, name) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(MD_BEGIN(name));

  const manifestFile = path.join(arDir, "installed.json");
  const manifest = () => readJson(manifestFile, {});
  const manifestSet = (k, v) => { const m = manifest(); if (v === undefined) delete m[k]; else m[k] = v; fs.mkdirSync(arDir, { recursive: true }); fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2)); };

  const hasGeminiKey = () => { try { return /^GEMINI_API_KEY=\S+/m.test(fs.readFileSync(path.join(root, ".env"), "utf8")); } catch { return false; } };
  const skillFile = path.join(cdir, "skills", "gemini-offload", "SKILL.md");
  const agentFile = path.join(cdir, "agents", "ar-verbose.md");
  const styleFile = path.join(cdir, "output-styles", "terse.md");
  const claudeMd = path.join(cdir, "CLAUDE.md");
  const hookFile = path.join(arDir, "hooks", "filter-test-output.mjs");
  const statusFile = path.join(arDir, "statusline.mjs");
  const geminiRule = `Bash(node ${root}/ar.mjs gemini *)`;

  // ---------------------------------------------------------------- the features: apply / remove / installed
  const F = {
    gateway: {
      apply: async () => actions.gatewayInstall ? actions.gatewayInstall() : false,
      remove: async () => actions.gatewayUninstall ? actions.gatewayUninstall() : true,
      installed: async () => actions.gatewayHealthy ? actions.gatewayHealthy() : false,
    },
    claude_code: {
      apply: async () => { if (!(await F.gateway.installed()) && !(await F.gateway.apply())) return false; return actions.claudeCodeOn ? actions.claudeCodeOn() : false; },
      remove: async () => actions.claudeCodeOff ? actions.claudeCodeOff() : true,
      installed: async () => readSettings().env?.ANTHROPIC_BASE_URL === GATEWAY_URL,
    },
    gemini_tools: {
      apply: async () => {
        if (!hasGeminiKey()) { say("gemini_tools needs GEMINI_API_KEY in .env (docs/GET-KEYS.md): not installed"); return false; }
        fs.mkdirSync(path.dirname(skillFile), { recursive: true });
        fs.writeFileSync(skillFile, fs.readFileSync(tpl("skills", "gemini-offload", "SKILL.md"), "utf8").replaceAll("__AR_ROOT__", root));
        edit((s) => { s.permissions = s.permissions || {}; s.permissions.allow = s.permissions.allow || []; if (!s.permissions.allow.includes(geminiRule)) s.permissions.allow.push(geminiRule); });
        return true;
      },
      remove: async () => {
        rm(path.dirname(skillFile));
        if (fs.existsSync(settingsFile)) edit((s) => {
          if (s.permissions?.allow) { s.permissions.allow = s.permissions.allow.filter((r) => r !== geminiRule); if (!s.permissions.allow.length) delete s.permissions.allow; if (!Object.keys(s.permissions).length) delete s.permissions; }
        });
        return true;
      },
      installed: async () => fs.existsSync(skillFile) && (readSettings().permissions?.allow || []).includes(geminiRule),
    },
    token_hooks: {
      apply: async () => {
        copy(tpl("hooks", "filter-test-output.mjs"), hookFile);
        edit((s) => {
          if (hasOurHook(s, "PreToolUse")) return;
          s.hooks = s.hooks || {}; s.hooks.PreToolUse = s.hooks.PreToolUse || [];
          s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: `node "${hookFile}"` }] });
        });
        return true;
      },
      remove: async () => { if (fs.existsSync(settingsFile)) edit((s) => removeHooks(s, "PreToolUse")); rm(path.dirname(hookFile)); return true; },
      installed: async () => hasOurHook(readSettings(), "PreToolUse"),
    },
    haiku_subagents: {
      apply: async () => { copy(tpl("agents", "ar-verbose.md"), agentFile); return true; },
      remove: async () => { rm(agentFile); return true; },
      installed: async () => fs.existsSync(agentFile),
    },
    compact_instructions: {
      apply: async () => { mdPut(claudeMd, "compact", fs.readFileSync(tpl("compact-instructions.md"), "utf8")); return true; },
      remove: async () => { mdDrop(claudeMd, "compact"); return true; },
      installed: async () => mdHas(claudeMd, "compact"),
    },
    terse_style: {
      apply: async () => {
        copy(tpl("output-styles", "terse.md"), styleFile);
        edit((s) => { if (s.outputStyle !== "Terse") { manifestSet("terse_style", { previous: s.outputStyle ?? null }); s.outputStyle = "Terse"; } });
        return true;
      },
      remove: async () => {
        rm(styleFile);
        if (fs.existsSync(settingsFile)) edit((s) => {
          if (s.outputStyle === "Terse") { const prev = manifest().terse_style?.previous; if (prev) s.outputStyle = prev; else delete s.outputStyle; }
        });
        manifestSet("terse_style", undefined);
        return true;
      },
      installed: async () => fs.existsSync(styleFile) && readSettings().outputStyle === "Terse",
    },
    statusline: {
      apply: async () => {
        const s0 = readSettings();
        if (s0.statusLine && !ours(s0.statusLine.command)) { say("statusline: you already have a status line; left untouched (docs/TOKEN-SAVING.md shows how to merge)"); return false; }
        copy(tpl("statusline.mjs"), statusFile);
        edit((s) => { s.statusLine = { type: "command", command: `node "${statusFile}"` }; });
        return true;
      },
      remove: async () => { if (fs.existsSync(settingsFile)) edit((s) => { if (s.statusLine && ours(s.statusLine.command)) delete s.statusLine; }); rm(statusFile); return true; },
      installed: async () => { const s = readSettings(); return Boolean(s.statusLine && ours(s.statusLine.command)); },
    },
    vscode_status: {
      apply: async () => actions.companionInstall ? actions.companionInstall() : false,
      remove: async () => actions.companionUninstall ? actions.companionUninstall() : true,
      installed: async () => actions.companionInstalled ? actions.companionInstalled() : false,
    },
    resume_on_reset: { apply: async () => true, remove: async () => true, installed: async () => wanted().features.resume_on_reset === true },
    notifications: { apply: async () => true, remove: async () => true, installed: async () => wanted().features.notifications === true },
    legacy_stack: {
      apply: async () => actions.legacyUp ? actions.legacyUp() : false,
      remove: async () => actions.legacyDown ? actions.legacyDown() : true,
      installed: async () => actions.legacyRunning ? actions.legacyRunning() : false,
    },
  };

  // ---------------------------------------------------------------- the switches
  async function on() {
    saveLocal({ enabled: true });
    const w = wanted(), results = {};
    for (const n of ORDER) {
      if (!w.features[n]) continue;
      try { results[n] = (await F[n].apply()) !== false ? "on" : "not installed"; } catch (e) { results[n] = `failed: ${e.message}`; }
    }
    return results;
  }
  async function off() {
    const results = {};
    for (const n of [...ORDER].reverse()) {
      try { results[n] = (await F[n].remove()) !== false ? "off" : "failed"; } catch (e) { results[n] = `failed: ${e.message}`; }
    }
    saveLocal({ enabled: false });
    return results;
  }
  async function set(name, value) {
    if (!F[name]) throw new Error(`unknown feature '${name}' (node ar.mjs feature list)`);
    saveLocal({ features: { [name]: Boolean(value) } });
    if (!value) return (await F[name].remove()) !== false ? "off" : "failed";
    if (!wanted().enabled) return "wanted (the umbrella is off: node ar.mjs on)";
    return (await F[name].apply()) !== false ? "on" : "not installed";
  }
  async function list() {
    const w = wanted(), rows = [];
    for (const n of ORDER) {
      let actual = false;
      try { actual = Boolean(await F[n].installed()); } catch {}
      rows.push({ name: n, wanted: Boolean(w.features[n]), installed: actual, what: DESCRIPTIONS[n] });
    }
    return { enabled: w.enabled, rows };
  }
  return { on, off, set, list, wanted, F };
}

// ---------------------------------------------------------------- report: what routing would save (or saved)
export function buildReport(lines, sinceMs = 24 * 3600 * 1000, now = Date.now()) {
  const COST_KEY = { "claude-haiku-5-5": "claude-haiku-cli", "claude-sonnet-5-5": "claude-sonnet-cli", "claude-opus-5-5": "claude-opus-cli" };
  const rows = lines.filter((r) => r.event === "route" && r.class === "main" && r.ts * 1000 >= now - sinceMs);
  const out = { requests: rows.length, shadow: 0, route: 0, drops: 0, errors: 0, would: {}, asked: {}, effort: {}, changed: 0, estSavingUsd: 0, estCostAskedUsd: 0, cacheHit: null };
  let read = 0, input = 0;
  for (const r of rows) {
    r.mode === "route" ? out.route++ : out.shadow++;
    if (r.context_drop) out.drops++;
    if ([400, 408, 413, 422].includes(r.status) || r.status >= 500) out.errors++;
    const asked = COST_KEY[r.asked] || r.asked;
    out.asked[asked] = (out.asked[asked] || 0) + 1;
    if (r.model) out.would[r.model] = (out.would[r.model] || 0) + 1;
    if (r.effort) out.effort[r.effort] = (out.effort[r.effort] || 0) + 1;
    if (r.model && asked && r.model !== asked) out.changed++;
    const cand = Object.fromEntries((r.candidates || []).map((c) => [c[0], c[2]]));
    if (cand[asked] != null && cand[r.model] != null) { out.estCostAskedUsd += cand[asked]; out.estSavingUsd += cand[asked] - cand[r.model]; }
    const u = r.usage || {};
    if (u.input_tokens != null) { input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); read += u.cache_read_input_tokens || 0; }
  }
  if (input) out.cacheHit = read / input;
  return out;
}

export function auditContext({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const items = [];
  const size = (file, label) => { try { const t = fs.readFileSync(file, "utf8"); items.push({ label, file, lines: t.split("\n").length, tokens: Math.round(t.length / 4) }); } catch {} };
  size(path.join(home, ".claude", "CLAUDE.md"), "user CLAUDE.md");
  size(path.join(cwd, "CLAUDE.md"), "project CLAUDE.md");
  size(path.join(cwd, "AGENTS.md"), "project AGENTS.md");
  const tips = [];
  for (const it of items) if (it.lines > 200 || it.tokens > 2500) tips.push(`${it.label} is ${it.lines} lines (~${it.tokens} tokens) and is read on EVERY turn: move workflow-specific parts to skills (docs say < 200 lines)`);
  const mcp = Object.keys(readJson(path.join(home, ".claude.json"), {}).mcpServers || {}).concat(Object.keys(readJson(path.join(cwd, ".mcp.json"), {}).mcpServers || {}));
  if (mcp.length) tips.push(`${mcp.length} MCP server(s) configured (${mcp.join(", ")}): disable the ones you do not use (/mcp); a CLI such as gh costs less context`);
  const s = readJson(path.join(home, ".claude", "settings.json"), {});
  if (!(s.hooks && s.hooks.PreToolUse)) tips.push("no PreToolUse hook: `node ar.mjs feature token_hooks on` cuts test output to failures");
  if (!fs.existsSync(path.join(home, ".claude", "agents", "ar-verbose.md"))) tips.push("`node ar.mjs feature haiku_subagents on` keeps test/build output out of the main context");
  return { items, tips };
}
