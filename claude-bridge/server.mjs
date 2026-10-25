// claude-bridge: OpenAI-compatible facade over the local `claude` CLI (Claude Code, your own login).
// Used by LiteLLM as the "cli" route for Claude. Runs on the host, not in Docker.
//
// Smooth model switching:
//  - every reply ends with an "actions" block (files edited, commands run) that lives in the chat
//    history, so any other model that answers next sees what Claude Code did;
//  - on each turn the bridge feeds Claude Code what happened since its last turn (replies from other
//    models, user messages, files changed on disk by anyone else).
//
// Also (auto-router v2):
//  - writes data/claude-quota.json from Claude Code's `rate_limit_event` (5 h / 7 day utilization + reset) so the gateway
//    can forecast when the subscription runs out;
//  - starts a fresh Claude Code session seeded with the project memory when the resumed one is near its context window;
//  - serves POST /memory/write and GET /memory/latest: session memory files in <project>/.auto-router/memory/.
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";

const PORT = Number(process.env.BRIDGE_PORT || 4100);
const BRIDGE_KEY = process.env.BRIDGE_KEY || "";
if (!BRIDGE_KEY) { console.error("BRIDGE_KEY is required"); process.exit(1); }
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
// No guessing about where the user keeps code: BRIDGE_ALLOWED_ROOTS (set by `node ar.mjs init`) is the whitelist,
// and its first entry is the fallback workspace.
const ROOTS_RAW = (process.env.BRIDGE_ALLOWED_ROOTS || "").split(",").map((r) => r.trim()).filter(Boolean);
if (!ROOTS_RAW.length) { console.error("BRIDGE_ALLOWED_ROOTS is required (comma-separated project folders Claude Code may edit)"); process.exit(1); }
const DEFAULT_CWD = process.env.BRIDGE_DEFAULT_CWD || path.resolve(ROOTS_RAW[0]);
// Values a caller (header/body) or the env may select. bypassPermissions and danger-full-access are deliberately absent.
const PERMISSION_MODES = new Set(["plan", "acceptEdits", "default"]);
const CODEX_SANDBOXES = new Set(["read-only", "workspace-write"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const AGENT_MODE = process.env.BRIDGE_AGENT_MODE || "acceptEdits";
if (!PERMISSION_MODES.has(AGENT_MODE)) { console.error(`BRIDGE_AGENT_MODE must be one of ${[...PERMISSION_MODES].join(", ")} (bypassPermissions is never allowed)`); process.exit(1); }
const BRIDGE_HOST = process.env.BRIDGE_HOST || "127.0.0.1";
if (["0.0.0.0", "::", "[::]", ""].includes(BRIDGE_HOST)) { console.error(`BRIDGE_HOST=${BRIDGE_HOST || "(empty)"} would expose the bridge (and your CLI subscriptions) to the local network. Use 127.0.0.1; on Linux with Docker use the docker0 address.`); process.exit(1); }
// No shell by default: edits are auto-accepted, commands are not. Opt in with e.g. "Bash(git status:*) Bash(npm test:*)".
const ALLOWED_TOOLS = process.env.BRIDGE_ALLOWED_TOOLS || "";
// The bridge only acts inside these directories (comma-separated).
const norm = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const ALLOWED_ROOTS = ROOTS_RAW.map(norm);
const inAllowedRoot = (d) => { const n = norm(d); return ALLOWED_ROOTS.some((r) => n === r || n.startsWith(r + path.sep)); };
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 10 * 60 * 1000);
const STATE_FILE = process.env.BRIDGE_STATE || path.join(os.homedir(), ".auto-router", "bridge-state.json");
const MODELS = {
  "claude-code-haiku": process.env.CC_HAIKU || "claude-haiku-5-5",
  "claude-code-sonnet": process.env.CC_SONNET || "claude-sonnet-5-5",
  "claude-code-opus": process.env.CC_OPUS || "claude-opus-5-5",
};
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// ---- OpenAI Codex CLI (ChatGPT Plus/Pro sign-in) ----
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODELS = { "codex-code-mini": process.env.CODEX_MODEL_MINI || "", "codex-code-main": process.env.CODEX_MODEL_MAIN || "", "codex-code-max": process.env.CODEX_MODEL_MAX || "" };
const CODEX_AGENT_SANDBOX = process.env.CODEX_AGENT_SANDBOX || "workspace-write"; // used when the request carries tools
if (!CODEX_SANDBOXES.has(CODEX_AGENT_SANDBOX)) { console.error(`CODEX_AGENT_SANDBOX must be one of ${[...CODEX_SANDBOXES].join(", ")} (danger-full-access is never allowed)`); process.exit(1); }
// ---- GitHub Copilot CLI (paid Copilot plan) ----
const COPILOT_BIN = process.env.COPILOT_BIN || "copilot";
const COPILOT_MODELS = { "copilot-code-mini": process.env.COPILOT_MODEL_MINI || "", "copilot-code-main": process.env.COPILOT_MODEL_MAIN || "", "copilot-code-max": process.env.COPILOT_MODEL_MAX || "" };
const COPILOT_PROMPT_INLINE_MAX = 6000;
const shellArg = (a) => (IS_WIN ? `"${String(a).replace(/"/g, '\\"')}"` : a);
const DATA_DIR = process.env.AUTO_ROUTER_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FRESH_SESSION_AT = Number(process.env.BRIDGE_FRESH_SESSION_AT || 0.8); // of the CLI's context window

// ---------- Claude subscription quota (from rate_limit_event) ----------
function recordQuota(info) {
  if (!info) return;
  const file = path.join(DATA_DIR, "claude-quota.json");
  let q = {};
  try { q = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const now = Date.now() / 1000;
  const windows = info.unifiedWindows || info.unified_windows || {};
  q.updated = now;
  q.status = info.status;
  q.resetsAt = info.resetsAt ?? info.resets_at;
  q.rateLimitType = info.rateLimitType ?? info.rate_limit_type;
  q.windows = windows;
  q.samples = q.samples || {};
  for (const [name, w] of Object.entries(windows)) {
    const util = w.utilization;
    if (util == null) continue;
    const reset = w.resetsAt ?? w.resets_at;
    const list = (q.samples[name] || []).filter((x) => x[2] === reset); // samples of the current window only
    list.push([now, util, reset]);
    q.samples[name] = list.slice(-60);
  }
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file + ".tmp", JSON.stringify(q)); fs.renameSync(file + ".tmp", file); } catch {}
}

// ---------- project memory (.auto-router/memory) ----------
function memoryDir(ws) { return path.join(ws, ".auto-router", "memory"); }
function ensureGitignore(ws) {
  if (!fs.existsSync(path.join(ws, ".git"))) return;
  const gi = path.join(ws, ".gitignore");
  let t = ""; try { t = fs.readFileSync(gi, "utf8"); } catch {}
  if (!/^\/?\.auto-router\/?\s*$/m.test(t)) fs.appendFileSync(gi, (t && !t.endsWith("\n") ? "\n" : "") + ".auto-router/\n");
}
function writeMemory({ session, markdown, hint, title, workspace }) {
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(String(session || ""))) throw new Error("bad session id");
  const ws = workspace && fs.existsSync(workspace) ? workspace : detectWorkspace([{ content: hint || "" }], null, null);
  if (!inAllowedRoot(ws)) throw new Error(`workspace ${ws} is outside BRIDGE_ALLOWED_ROOTS`);
  const dir = memoryDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  ensureGitignore(ws);
  const file = path.join(dir, `${session}.md`);
  fs.writeFileSync(file, String(markdown || "").slice(0, 200000));
  const index = path.join(dir, "INDEX.md");
  let lines = []; try { lines = fs.readFileSync(index, "utf8").split("\n").filter((l) => l.startsWith("- ")); } catch {}
  lines = lines.filter((l) => !l.includes(`(${session}.md)`));
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  lines.unshift(`- ${stamp} · [${session}](${session}.md) · ${String(title || "").replace(/\s+/g, " ").slice(0, 100)}`);
  fs.writeFileSync(index, "# auto-router memory (newest first)\n\n" + lines.slice(0, 200).join("\n") + "\n");
  return { workspace: ws, path: path.relative(ws, file) };
}
function latestMemory(ws) {
  const dir = memoryDir(ws);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "INDEX.md"); } catch { return null; }
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  let index = ""; try { index = fs.readFileSync(path.join(dir, "INDEX.md"), "utf8"); } catch {}
  return { workspace: ws, index, latest_path: path.join(".auto-router", "memory", files[0]),
    latest: fs.readFileSync(path.join(dir, files[0]), "utf8") };
}

// ---------- state ----------
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
const saveState = () => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
};
const locks = new Map();
const withLock = async (key, fn) => {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  locks.set(key, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === next) locks.delete(key); }
};

// ---------- helpers ----------
const textOf = (c) =>
  typeof c === "string" ? c
  : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text ?? p?.output ?? "")).join(" ")
  : "";

function projectRoot(p) {
  let cur = p;
  while (cur && !fs.existsSync(cur)) cur = path.dirname(cur);
  if (!cur || cur === "/") return null;
  if (fs.statSync(cur).isFile()) cur = path.dirname(cur);
  for (let d = cur; d !== path.dirname(d); d = path.dirname(d)) {
    if (d === os.homedir()) break;
    if (["\.git", "package.json", "pyproject.toml"].some((f) => fs.existsSync(path.join(d, f)))) return d;
  }
  return cur === os.homedir() ? null : cur;
}

function detectWorkspace(messages, header, saved) {
  if (header && fs.existsSync(header)) return header;
  const counts = new Map();
  // absolute paths: POSIX (/Users, /home, ...) and Windows (C:\\... or C:/...)
  const re = /(?:(?:\/Users|\/home|\/private|\/tmp|\/Volumes|\/mnt|\/workspaces|\/opt|\/srv)\/|[A-Za-z]:[\\/])[^\s"'`)\]},;<>]+/g;
  for (const m of messages) {
    for (let hit of textOf(m.content).match(re) || []) {
      hit = hit.replace(/[.:]+$/, "");
      if (/[\\/](\.claude|node_modules|Library|AppData)\b/.test(hit)) continue;
      const root = projectRoot(hit);
      if (root) counts.set(root, (counts.get(root) || 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] || saved || DEFAULT_CWD;
}

function transcript(msgs) {
  const out = [];
  for (const m of msgs) {
    if (m.role === "system" || m.role === "developer") continue;
    if (m.role === "tool") { out.push(`[tool result] ${textOf(m.content).slice(0, 300)}`); continue; }
    const t = textOf(m.content).trim();
    if (t) out.push(`${m.role === "user" ? "User" : "Assistant"}: ${t.slice(0, 6000)}`);
  }
  return out.join("\n\n");
}

function walkChanged(root, sinceMs, out = [], depth = 0, budget = { n: 4000 }) {
  if (depth > 5 || out.length >= 30) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (budget.n-- <= 0 || out.length >= 30) break;
    if (/^(\.git|node_modules|\.auto-router|\.venv|__pycache__|dist|build)$/.test(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkChanged(full, sinceMs, out, depth + 1, budget);
    else { try { if (fs.statSync(full).mtimeMs > sinceMs) out.push(full); } catch {} }
  }
  return out;
}

// Files modified after `sinceMs`: `git status` when the folder is a repository, otherwise a bounded folder scan.
function changedSince(cwd, sinceMs) {
  try {
    const out = execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean).map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
      .filter((f) => { try { return fs.statSync(path.join(cwd, f)).mtimeMs > sinceMs; } catch { return true; } })
      .slice(0, 30);
  } catch {
    return walkChanged(cwd, sinceMs).map((f) => path.relative(cwd, f));
  }
}

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

// ---------- core ----------
async function handle(req, res, body) {
  const messages = body.messages || [];
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const task = textOf(messages[lastUserIdx]?.content).trim();
  const firstUser = textOf(messages.find((m) => m.role === "user")?.content).slice(0, 2000);
  const convId = createHash("sha1").update(firstUser).digest("hex");
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const modeHeader = req.headers["x-claude-mode"];
  const permission = PERMISSION_MODES.has(modeHeader) ? modeHeader : (hasTools ? AGENT_MODE : "plan");
  const effort = { low: "low", medium: "medium", high: "high", max: "max" }[body.reasoning_effort] || null;
  const cliModel = Object.hasOwn(MODELS, body.model) ? MODELS[body.model] : null;
  if (!cliModel || !SAFE_ID.test(cliModel)) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `claude-bridge: unknown model '${String(body.model).slice(0, 60)}'`, type: "invalid_request_error" } }));
  }
  const stream = body.stream === true;

  return withLock(convId, async () => {
    const st = state[convId] || {};
    const cwd = detectWorkspace(messages, req.headers["x-workspace"], st.cwd);
    if (!inAllowedRoot(cwd)) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `claude-bridge: workspace ${cwd} is outside BRIDGE_ALLOWED_ROOTS`, type: "permission_error" } }));
    }
    const nearFull = (st.ctxRatio || 0) >= FRESH_SESSION_AT;
    const resuming = Boolean(st.sessionId) && messages.length >= (st.seen || 0) && !nearFull;
    const sessionId = resuming ? st.sessionId : randomUUID();

    // what Claude Code has not seen yet
    const unseen = resuming ? messages.slice(st.seen, lastUserIdx) : messages.slice(0, lastUserIdx);
    const parts = [];
    if (nearFull) {
      const mem = latestMemory(cwd);
      parts.push("## Note\nThe previous Claude Code session for this chat was close to its context limit, so this is a fresh session." +
        (mem ? ` Project memory (${mem.latest_path}):\n\n${mem.latest.slice(0, 30000)}` : ""));
    }
    const ctx = transcript(nearFull ? messages.slice(Math.max(0, lastUserIdx - 6), lastUserIdx) : unseen);
    if (ctx) parts.push(`## Conversation since your last turn (other models/people may have answered)\n${ctx}`);
    if (resuming) {
      const ext = changedSince(cwd, st.lastEnd || 0);
      if (ext.length) parts.push(`## Files changed on disk since your last turn\n${ext.map((f) => `- ${f}`).join("\n")}\nRe-read them before editing.`);
    }
    parts.push(`## Current request\n${task}`);
    const prompt = parts.join("\n\n");

    const fullPrompt = "## How you are being used\nYou are driven through a chat bridge; the reply is shown in a VS Code chat. " +
      "Do the work with your tools, then answer concisely. Other models may continue this conversation, so state clearly " +
      "what you changed and any open follow-ups.\n\n" + prompt;
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", cliModel, "--permission-mode", permission];
    if (permission !== "plan" && ALLOWED_TOOLS) args.push("--allowedTools", IS_WIN ? `"${ALLOWED_TOOLS}"` : ALLOWED_TOOLS);
    if (effort) args.push("--effort", effort);
    args.push(resuming ? "--resume" : "--session-id", sessionId);

    const env = { ...process.env };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    // The CLI must use the subscription login: an API key in the environment would bill the (empty) API account.
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[k];
    // Windows: npm installs `claude.cmd`, which Node can only start through a shell (the prompt goes through stdin, so
    // nothing user-controlled is ever put on the command line).
    const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: IS_WIN && /\.(cmd|bat)$/i.test(CLAUDE_BIN) });
    child.stdin.on("error", () => {});
    child.stdin.end(fullPrompt);
    const killer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    res.on("close", () => { if (child.exitCode === null) child.kill("SIGTERM"); });

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null) => ({ id, object: "chat.completion.chunk", created, model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }] });
    let started = false, full = "", errText = "", resultErr = null, buf = "", cliUsage = null, costUsd = null, ctxRatio = null;
    const files = new Set(), cmds = [];
    const begin = () => {
      if (started) return; started = true;
      if (stream) { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); sse(res, chunk({ role: "assistant" })); }
    };
    const emit = (t) => { full += t; if (stream) { begin(); sse(res, chunk({ content: t })); } };

    child.stderr.on("data", (d) => (errText += d));
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "stream_event" && ev.event?.delta?.type === "text_delta") emit(ev.event.delta.text);
        else if (ev.type === "assistant") {
          for (const b of ev.message?.content || []) {
            if (b.type !== "tool_use") continue;
            if (EDIT_TOOLS.has(b.name)) files.add(path.relative(cwd, b.input?.file_path || b.input?.notebook_path || "?"));
            else if (b.name === "Bash" && b.input?.command) cmds.push(String(b.input.command).split("\n")[0].slice(0, 120));
          }
        } else if (ev.type === "result" && (ev.is_error || ev.subtype !== "success")) resultErr = ev.result || ev.subtype;
        else if (ev.type === "result") {
          cliUsage = ev.usage || null; costUsd = ev.total_cost_usd ?? null;
          const mu = Object.values(ev.modelUsage || {})[0];
          const used = (cliUsage?.input_tokens || 0) + (cliUsage?.cache_read_input_tokens || 0) + (cliUsage?.cache_creation_input_tokens || 0);
          if (mu?.contextWindow) ctxRatio = used / mu.contextWindow;
        }
        else if (ev.type === "rate_limit_event") {
          recordQuota(ev.rate_limit_info);
          if (ev.rate_limit_info?.status === "rejected") resultErr = "rate limit";
        }
      }
    });

    const code = await new Promise((r) => child.on("close", r));
    clearTimeout(killer);

    if ((code !== 0 || resultErr) && full) {
      // Partial answer already sent/buffered. Report what was done, save state, then break the response so the
      // gateway sees an error and continues on another model (streaming) or retries elsewhere (non-streaming).
      const msg = String(resultErr || errText || `claude exited ${code}`).slice(0, 300);
      const note = `\n\n---\n*Claude Code (${cliModel}) was interrupted: ${msg}*` +
        (files.size ? `\n- files edited before the interruption: ${[...files].map((f) => `\`${f}\``).join(", ")}` : "");
      state[convId] = { sessionId, cwd, seen: messages.length + 1, lastEnd: Date.now() };
      saveState();
      if (stream && started) { emit(note); return res.destroy(new Error("claude interrupted")); }
      if (!res.headersSent) res.writeHead(/limit|quota|usage|rate/i.test(msg) ? 429 : 502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `claude-bridge: ${msg}`, type: "server_error" } }));
    }
    if ((code !== 0 || resultErr) && !full) {
      const msg = String(resultErr || errText || `claude exited ${code}`).slice(0, 400);
      const limited = /limit|quota|usage|rate/i.test(msg);
      if (resuming && /no conversation|session/i.test(msg)) { delete state[convId]; saveState(); }
      const status = limited ? 429 : 502;
      if (!res.headersSent) { res.writeHead(status, { "content-type": "application/json" }); }
      return res.end(JSON.stringify({ error: { message: `claude-bridge: ${msg}`, type: limited ? "rate_limit_error" : "server_error" } }));
    }

    const meta = [`${cliModel}`, permission, effort].filter(Boolean).join(" · ");
    let actions = `\n\n---\n*Claude Code (${meta})*`;
    if (files.size) actions += `\n- files edited: ${[...files].map((f) => `\`${f}\``).join(", ")}`;
    if (cmds.length) actions += `\n- commands: ${cmds.slice(0, 8).map((c) => `\`${c}\``).join(", ")}`;
    if (permission === "plan") actions += `\n- read-only mode (no edits made)`;
    emit(actions);

    state[convId] = { sessionId, cwd, seen: messages.length + 1, lastEnd: Date.now(), ctxRatio };
    saveState();

    const u = cliUsage || {};
    const usage = { prompt_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      completion_tokens: u.output_tokens || 0 };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    if (stream) {
      begin(); sse(res, chunk({}, "stop"));
      sse(res, { id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage });
      res.write("data: [DONE]\n\n"); return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }],
      usage, cost_usd: costUsd }));
  });
}

// ---------- OpenAI Codex CLI route ----------
// Same idea as the Claude route: run the official `codex` program with the user's own ChatGPT login (`codex login`),
// non-interactively (`codex exec --json`), prompt through stdin. Every turn is a fresh Codex session: the conversation so
// far is replayed in the prompt (no `resume`, whose flags differ from `exec`).
async function handleCodex(req, res, body) {
  const messages = body.messages || [];
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const task = textOf(messages[lastUserIdx]?.content).trim();
  const firstUser = textOf(messages.find((m) => m.role === "user")?.content).slice(0, 2000);
  const convId = "codex:" + createHash("sha1").update(firstUser).digest("hex");
  const wantedSandbox = req.headers["x-codex-sandbox"];
  const sandbox = CODEX_SANDBOXES.has(wantedSandbox) ? wantedSandbox : (Array.isArray(body.tools) && body.tools.length ? CODEX_AGENT_SANDBOX : "read-only");
  const effort = { low: "low", medium: "medium", high: "high" }[body.reasoning_effort] || null;
  const stream = body.stream === true;
  if (!Object.hasOwn(CODEX_MODELS, body.model)) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `codex-bridge: unknown model '${String(body.model).slice(0, 60)}'`, type: "invalid_request_error" } }));
  }
  const model = CODEX_MODELS[body.model] || "";
  if (model && !SAFE_ID.test(model)) { res.writeHead(400); return res.end("codex-bridge: CODEX_MODEL_* has an unsafe value"); }

  return withLock(convId, async () => {
    const st = state[convId] || {};
    const cwd = detectWorkspace(messages, req.headers["x-workspace"], st.cwd);
    if (!inAllowedRoot(cwd)) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `codex-bridge: workspace ${cwd} is outside BRIDGE_ALLOWED_ROOTS`, type: "permission_error" } }));
    }
    const parts = ["## How you are being used\nYou are driven through a chat bridge; the reply is shown in a VS Code chat. Do the work with your tools, " +
      "then answer concisely. Other models may continue this conversation, so state what you changed and any open follow-ups."];
    const history = transcript(messages.slice(Math.max(0, lastUserIdx - 12), lastUserIdx));
    if (history) parts.push(`## Conversation so far (other models may have answered)\n${history}`);
    const ext = changedSince(cwd, st.lastEnd || 0);
    if (ext.length) parts.push(`## Files changed on disk since your last turn\n${ext.map((f) => `- ${f}`).join("\n")}\nRe-read them before editing.`);
    parts.push(`## Current request\n${task}`);

    const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", sandbox, "-C", cwd];
    if (model) args.push("-m", model);
    if (effort) args.push("-c", shellArg(`model_reasoning_effort="${effort}"`));
    args.push("-");
    const env = { ...process.env };
    for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE"]) delete env[k]; // use the ChatGPT login, never an API key
    const child = spawn(CODEX_BIN, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: IS_WIN && /\.(cmd|bat)$/i.test(CODEX_BIN) });
    child.stdin.on("error", () => {});
    child.stdin.end(parts.join("\n\n"));
    const killer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    res.on("close", () => { if (child.exitCode === null) child.kill("SIGTERM"); });

    const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null) => ({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    let started = false, full = "", errText = "", resultErr = null, buf = "", usage = null;
    const files = new Set(), cmds = [];
    const begin = () => { if (started) return; started = true; if (stream) { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); sse(res, chunk({ role: "assistant" })); } };
    const emit = (t) => { full += t; if (stream) { begin(); sse(res, chunk({ content: t })); } };

    child.stderr.on("data", (d) => (errText += d));
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const item = ev.item || {};
        if (ev.type === "item.completed" && item.type === "agent_message" && item.text) emit((full ? "\n\n" : "") + item.text);
        else if (ev.type === "item.completed" && item.type === "command_execution" && item.command) cmds.push(String(item.command).split("\n")[0].slice(0, 120));
        else if (ev.type === "item.completed" && item.type === "file_change") {
          for (const c of item.changes || []) if (c.path) files.add(path.relative(cwd, c.path));
          if (item.path) files.add(path.relative(cwd, item.path));
        } else if (ev.type === "turn.completed") usage = ev.usage || null;
        else if (ev.type === "turn.failed" || ev.type === "error") resultErr = ev.error?.message || ev.message || "codex error";
      }
    });
    const code = await new Promise((r) => child.on("close", r));
    clearTimeout(killer);

    if (code !== 0 || resultErr) {
      const msg = String(resultErr || errText || `codex exited ${code}`).slice(0, 400);
      const limited = /limit|quota|usage|rate|credits/i.test(msg);
      state[convId] = { cwd, lastEnd: Date.now() };
      saveState();
      if (full && stream && started) { emit(`\n\n---\n*Codex was interrupted: ${msg}*` + (files.size ? `\n- files edited before the interruption: ${[...files].map((f) => `\`${f}\``).join(", ")}` : "")); return res.destroy(new Error("codex interrupted")); }
      if (!res.headersSent) res.writeHead(limited ? 429 : 502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `codex-bridge: ${msg}`, type: limited ? "rate_limit_error" : "server_error" } }));
    }
    let actions = `\n\n---\n*Codex (${[model || "default model", sandbox, effort].filter(Boolean).join(" · ")})*`;
    if (files.size) actions += `\n- files edited: ${[...files].map((f) => `\`${f}\``).join(", ")}`;
    if (cmds.length) actions += `\n- commands: ${cmds.slice(0, 8).map((c) => `\`${c}\``).join(", ")}`;
    if (sandbox === "read-only") actions += `\n- read-only mode (no edits made)`;
    emit(actions);
    state[convId] = { cwd, lastEnd: Date.now() };
    saveState();
    const u = usage || {};
    const use = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0 };
    use.total_tokens = use.prompt_tokens + use.completion_tokens;
    if (stream) { begin(); sse(res, chunk({}, "stop")); sse(res, { id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: use }); res.write("data: [DONE]\n\n"); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }], usage: use }));
  });
}

// ---------- GitHub Copilot CLI route ----------
// `copilot -p <prompt> -s` (programmatic mode, silent = only the agent's answer) with the user's own Copilot login.
// The prompt can only be passed as an argument (stdin is not documented), so long prompts, and anything on Windows .cmd
// launchers, are written to <workspace>/.auto-router/prompts/ and the CLI is told to read that file.
async function handleCopilot(req, res, body) {
  const messages = body.messages || [];
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const task = textOf(messages[lastUserIdx]?.content).trim();
  const firstUser = textOf(messages.find((m) => m.role === "user")?.content).slice(0, 2000);
  const convId = "copilot:" + createHash("sha1").update(firstUser).digest("hex");
  const agent = Array.isArray(body.tools) && body.tools.length > 0 && req.headers["x-copilot-mode"] !== "read-only";
  const stream = body.stream === true;
  if (!Object.hasOwn(COPILOT_MODELS, body.model)) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `copilot-bridge: unknown model '${String(body.model).slice(0, 60)}'`, type: "invalid_request_error" } }));
  }
  const model = COPILOT_MODELS[body.model] || "";
  if (model && !SAFE_ID.test(model)) { res.writeHead(400); return res.end("copilot-bridge: COPILOT_MODEL_* has an unsafe value"); }

  return withLock(convId, async () => {
    const st = state[convId] || {};
    const cwd = detectWorkspace(messages, req.headers["x-workspace"], st.cwd);
    if (!inAllowedRoot(cwd)) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `copilot-bridge: workspace ${cwd} is outside BRIDGE_ALLOWED_ROOTS`, type: "permission_error" } }));
    }
    const parts = ["## How you are being used\nYou are driven through a chat bridge; the reply is shown in a VS Code chat. " +
      (agent ? "Do the work with your tools, then answer concisely. " : "Read-only: do not modify files. ") +
      "Other models may continue this conversation, so state what you changed and any open follow-ups."];
    const history = transcript(messages.slice(Math.max(0, lastUserIdx - 12), lastUserIdx));
    if (history) parts.push(`## Conversation so far (other models may have answered)\n${history}`);
    const ext = changedSince(cwd, st.lastEnd || 0);
    if (ext.length) parts.push(`## Files changed on disk since your last turn\n${ext.map((f) => `- ${f}`).join("\n")}\nRe-read them before editing.`);
    parts.push(`## Current request\n${task}`);
    let prompt = parts.join("\n\n");
    let promptFile = null;
    if (prompt.length > COPILOT_PROMPT_INLINE_MAX || (IS_WIN && /\.(cmd|bat)$/i.test(COPILOT_BIN))) {
      const dir = path.join(cwd, ".auto-router", "prompts");
      fs.mkdirSync(dir, { recursive: true });
      try { ensureGitignore(cwd); } catch {}
      promptFile = path.join(dir, `${randomUUID().slice(0, 8)}.md`);
      fs.writeFileSync(promptFile, prompt);
      prompt = `Read the file ${path.relative(cwd, promptFile)} and follow the instructions in it exactly. Reply only with your answer to its "Current request" section.`;
    }
    const args = ["-p", IS_WIN && /\.(cmd|bat)$/i.test(COPILOT_BIN) ? `"${prompt.replace(/"/g, '\\"')}"` : prompt, "-s", "--no-ask-user"];
    if (model) args.push(`--model=${model}`);
    args.push("--allow-tool=read");
    if (agent) args.push("--allow-tool=write");
    for (const t of ALLOWED_TOOLS.split(/\s+/).filter(Boolean)) if (agent && t.startsWith("shell")) args.push(`--allow-tool=${t.replace(/^Bash/, "shell")}`);
    const env = { ...process.env };
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]) delete env[k]; // use the Copilot login, not an ambient token
    env.COPILOT_AUTO_UPDATE = "false";
    const t0 = Date.now();
    const child = spawn(COPILOT_BIN, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: IS_WIN && /\.(cmd|bat)$/i.test(COPILOT_BIN) });
    const killer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    res.on("close", () => { if (child.exitCode === null) child.kill("SIGTERM"); });
    let out = "", errText = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errText += d));
    const code = await new Promise((r) => child.on("close", r));
    clearTimeout(killer);
    if (promptFile) { try { fs.unlinkSync(promptFile); } catch {} }

    const text = out.trim();
    if (code !== 0 || !text) {
      const msg = String(errText || out || `copilot exited ${code}`).trim().slice(-400);
      const limited = /limit|quota|premium|rate|exceeded|usage/i.test(msg);
      state[convId] = { cwd, lastEnd: Date.now() };
      saveState();
      res.writeHead(limited ? 429 : 502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `copilot-bridge: ${msg}`, type: limited ? "rate_limit_error" : "server_error" } }));
    }
    const files = changedSince(cwd, t0 - 1000).filter((f) => !f.startsWith(".auto-router"));
    let actions = `\n\n---\n*GitHub Copilot (${[model || "default model", agent ? "can edit" : "read-only"].join(" · ")})*`;
    if (files.length) actions += `\n- files changed: ${files.slice(0, 12).map((f) => `\`${f}\``).join(", ")}`;
    if (!agent) actions += `\n- read-only mode (no edits made)`;
    const full = text + actions;
    state[convId] = { cwd, lastEnd: Date.now() };
    saveState();
    const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
    const pt = Math.ceil(prompt.length / 4), ct = Math.ceil(full.length / 4); // the CLI reports no token counts: estimate
    const use = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finish = null) => ({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      sse(res, chunk({ role: "assistant" })); sse(res, chunk({ content: full })); sse(res, chunk({}, "stop"));
      sse(res, { id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: use });
      res.write("data: [DONE]\n\n"); return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }], usage: use }));
  });
}

http.createServer((req, res) => {
  if (req.url === "/healthz") return res.end("ok");
  if (req.headers.authorization !== `Bearer ${BRIDGE_KEY}`) { res.writeHead(401); return res.end("unauthorized"); }
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [...Object.keys(MODELS), ...Object.keys(CODEX_MODELS), ...Object.keys(COPILOT_MODELS)].map((id) => ({ id, object: "model", owned_by: id.startsWith("codex") ? "codex" : id.startsWith("copilot") ? "github-copilot" : "claude-code" })) }));
  }
  if (req.method === "POST" && req.url.startsWith("/memory/write")) {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      try {
        const out = writeMemory(JSON.parse(raw));
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/memory/latest")) {
    const ws = new URL(req.url, "http://x").searchParams.get("workspace") || "";
    const target = path.resolve(ws || DEFAULT_CWD);
    if (!inAllowedRoot(target)) { res.writeHead(403); return res.end(JSON.stringify({ error: "outside allowed roots" })); }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(latestMemory(target) || { workspace: target, index: "", latest: null }));
  }
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); return res.end("bad json"); }
      (String(body.model || "").startsWith("codex-code-") ? handleCodex : String(body.model || "").startsWith("copilot-code-") ? handleCopilot : handle)(req, res, body).catch((e) => { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: String(e) } })); });
    });
    return;
  }
  res.writeHead(404); res.end("not found");
}).listen(PORT, BRIDGE_HOST, () => console.log(`claude-bridge on ${BRIDGE_HOST}:${PORT}`));
