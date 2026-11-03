// auto-router companion (1.0).
//  - status bar: the model and effort Claude Code is really using, "sonnet (medium)", and the plan use. It asks the local gateway
//    (GET /state); without a gateway it shows the model and effort from ~/.claude/settings.json. No tokens are spent.
//  - "Add to Claude Code" in the Explorer menu.
//  - legacy (setting autoRouter.legacyStack, off by default): the Copilot Chat stack's context status and automatic new chat
//    (data/context-state.json written by the LiteLLM hook).
const vscode = require("vscode");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

let item, state = null, startedAt = Date.now() / 1000, handled = new Set(), log;

function statePath() {
  const p = vscode.workspace.getConfiguration("autoRouter").get("stateFile");
  if (p && p.trim()) return p.replace(/^~/, os.homedir());
  try { // written by `node ar.mjs init`
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".auto-router", "config.json"), "utf8"));
    if (cfg.stateFile) return cfg.stateFile;
  } catch {}
  return path.join(os.homedir(), ".auto-router", "context-state.json");
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), "utf8")); } catch { return null; }
}

function render() {
  if (!state) { item.text = "$(circuit-board) auto-router: idle"; item.tooltip = `No state yet (${statePath()})`; return; }
  const q = state.quota || {};
  const qWarn = ["warn", "critical", "exhausted"].includes(q.state) ? ` $(warning) quota ${q.state}` : "";
  const ctx = Math.round(state.ctx_pct || 0);
  const lock = state.safety_mode === "on" ? "🔒 " : "";
  const sens = state.sensitive ? " · 🔒 sensível" : "";
  item.text = `${lock}$(circuit-board) ${state.mode || "?"} → ${state.model || "?"} · ctx ${ctx}%${qWarn}${sens}`;
  item.backgroundColor = ctx >= 85 || q.state === "critical" || q.state === "exhausted"
    ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  const md = new vscode.MarkdownString(
    `**auto-router** · session \`${state.session}\`\n\n` +
    `- profile: auto-${state.mode}\n- safety mode: ${state.safety_mode || "?"}${state.sensitive ? " · this conversation holds sensitive data: only allowed models are used" : ""}\n- model: ${state.model}\n- models used: ${(state.trail || []).join(" → ")}\n` +
    `- context: ${state.ctx_tokens} / ${state.ctx_window} tokens (${ctx}%)${state.compacted ? " · compacted for the model" : ""}\n` +
    `- quota: ${q.state || "?"}${q.window ? ` (${q.window}` + (q.utilization != null ? ` ${Math.round(q.utilization * 100)}%` : "") + (q.eta_min != null ? `, ~${Math.round(q.eta_min)} min left` : "") + ")" : ""}\n` +
    (state.memory_file ? `- memory: ${state.memory_file}\n` : ""));
  item.tooltip = md;
}

function continuationPrompt(s) {
  const mem = s.memory_file ? `\`${s.memory_file}\`` : "the latest file in `.auto-router/memory/`";
  return `Continue the previous task from where it stopped. The previous chat ran out of context; its summary, decisions, ` +
    `files touched and next steps are in ${mem} (also listed in \`.auto-router/memory/INDEX.md\`). Read that file first, ` +
    `then continue. Do not redo finished work.`;
}

async function openNewChat(s, reason) {
  const cfg = vscode.workspace.getConfiguration("autoRouter");
  const query = continuationPrompt(s);
  const attach = [];
  if (s.workspace && s.memory_file) attach.push(vscode.Uri.file(path.join(s.workspace, s.memory_file)));
  try {
    await vscode.commands.executeCommand("workbench.action.chat.newChat");
    const opts = { query, isPartialQuery: !cfg.get("autoSend") };
    if (attach.length) opts.attachFiles = attach;
    await vscode.commands.executeCommand("workbench.action.chat.open", opts);
    log.appendLine(`[${new Date().toISOString()}] new chat opened (${reason}); autoSend=${cfg.get("autoSend")} session=${s.session}`);
    vscode.window.showInformationMessage(
      `auto-router: context ${Math.round(s.ctx_pct)}% — continued in a new chat from ${s.memory_file || "the session memory"}.`);
  } catch (e) {
    log.appendLine(`[${new Date().toISOString()}] could not open/send the new chat: ${e}`);
    await vscode.env.clipboard.writeText(query);
    vscode.window.showWarningMessage("auto-router: open a new chat and paste (the continuation prompt is in the clipboard).");
  }
}

function onChange() {
  const s = readState();
  if (!s) return;
  state = s;
  render();
  const key = `${s.session}`;
  if (s.action === "new_chat" && s.updated >= startedAt - 5 && !handled.has(key)
      && vscode.workspace.getConfiguration("autoRouter").get("legacyStack")
      && vscode.workspace.getConfiguration("autoRouter").get("autoNewChat")) {
    handled.add(key);
    openNewChat(s, "context nearly full");
  }
}

function gatewayUrl() {
  return (vscode.workspace.getConfiguration("autoRouter").get("gatewayUrl") || "http://127.0.0.1:4001").replace(/\/$/, "");
}

function fetchState() {
  return new Promise((resolve) => {
    const req = http.get(gatewayUrl() + "/state", { timeout: 800 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function family(s) {
  s = String(s || "");
  for (const f of ["haiku", "sonnet", "opus"]) if (s.toLowerCase().includes(f)) return f;
  return s || "?";
}

function claudeSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8")); } catch { return {}; }
}

/** What the status bar says: "sonnet (medium) · 5h 42%". */
async function renderGateway() {
  const settings = claudeSettings();
  const routed = Boolean(settings.env && /127\.0\.0\.1:4001|localhost:4001/.test(settings.env.ANTHROPIC_BASE_URL || ""));
  const st = await fetchState();
  if (routed && !st) {
    item.text = "$(warning) auto-router: gateway not answering";
    item.tooltip = "Claude Code is pointed at the gateway but it does not answer. Run: node ar.mjs status  (or node ar.mjs off to go direct)";
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    return;
  }
  item.backgroundColor = undefined;
  let model = family(settings.model), effort = settings.effortLevel, extra = "", plan = "";
  if (st && st.sessions) {
    const latest = Object.values(st.sessions).sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
    if (latest && latest.sent && latest.sent.model) {
      model = latest.sent.model; effort = latest.sent.effort || effort;
      if (st.mode === "shadow" && latest.model && family(latest.model) !== model) extra = ` · auto: ${family(latest.model)}${latest.effort ? ` (${latest.effort})` : ""}`;
    }
  }
  const w = st && st.claude && st.claude.windows;
  if (w && w["5h"] && w["5h"].utilization != null) plan = ` · 5h ${Math.round(w["5h"].utilization * 100)}%`;
  if (st && st.claude && st.claude.exhausted) { plan += " · plan out"; item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground"); }
  item.text = `$(circuit-board) ${model}${effort ? ` (${effort})` : ""}${extra}${plan}`;
  item.tooltip = st ? `auto-router ${st.version || ""} · mode ${st.mode || "?"} · most recent session. Click for details.`
    : "No gateway: showing the model and effort from ~/.claude/settings.json";
}

function activate(context) {
  log = vscode.window.createOutputChannel("auto-router");
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "autoRouter.showStatus";
  item.show();
  publishWorkspace();
  const legacy = vscode.workspace.getConfiguration("autoRouter").get("legacyStack");
  if (legacy) {
    state = readState();
    render();
    fs.watchFile(statePath(), { interval: 1000 }, onChange);
  } else {
    renderGateway();
  }
  const timer = legacy ? null : setInterval(renderGateway, 3000);
  context.subscriptions.push(vscode.window.onDidChangeWindowState((w) => { if (w.focused) publishWorkspace(); }));
  context.subscriptions.push(item, log, { dispose: () => { if (timer) clearInterval(timer); fs.unwatchFile(statePath()); } },
    vscode.commands.registerCommand("autoRouter.showStatus", async () => {
      log.appendLine(JSON.stringify(legacy ? readState() : await fetchState(), null, 2)); log.show(true);
    }),
    vscode.commands.registerCommand("autoRouter.addToClaudeCode", addToClaudeCode));
  log.appendLine(`auto-router companion active (${legacy ? "legacy stack, watching " + statePath() : "gateway " + gatewayUrl()})`);
}

// The Claude Code extension has no Explorer context-menu entry; its own "Insert @-Mention Reference" command only works on the
// active editor. So each selected file is opened in a preview (focus kept) and that command is run on it. Folders, or a Claude
// Code version without the command, fall back to `@path` references on the clipboard: the user pastes them into the prompt box.
async function addToClaudeCode(clicked, selected) {
  const uris = (selected && selected.length ? selected : [clicked]).filter(Boolean);
  if (!uris.length) return;
  const commands = await vscode.commands.getCommands(true);
  const canInsert = commands.includes("claude-vscode.insertAtMention");
  const leftovers = [];
  for (const uri of uris) {
    let isDir = false;
    try { isDir = (await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory; } catch {}
    if (isDir || !canInsert) { leftovers.push(uri); continue; }
    try {
      await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: false });
      await vscode.commands.executeCommand("claude-vscode.insertAtMention");
    } catch (e) {
      log.appendLine(`addToClaudeCode: ${uri.fsPath}: ${e && e.message}`);
      leftovers.push(uri);
    }
  }
  if (!leftovers.length) return;
  const refs = leftovers.map((u) => {
    const rel = vscode.workspace.asRelativePath(u, false);
    return "@" + (rel.includes(" ") ? `"${rel}"` : rel) + (isDirSync(u) ? "/" : "");
  });
  await vscode.env.clipboard.writeText(refs.join(" ") + " ");
  if (commands.includes("claude-vscode.focus")) await vscode.commands.executeCommand("claude-vscode.focus");
  vscode.window.showInformationMessage(`auto-router: ${refs.length} reference(s) copied — paste (Cmd/Ctrl+V) into Claude Code.`);
}

function isDirSync(uri) {
  try { return fs.statSync(uri.fsPath).isDirectory(); } catch { return false; }
}

// SEC-03: tell the bridge which folder this window works in (a trusted source, valid 6 h), instead of letting it guess from message text.
function publishWorkspace() {
  try {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!folder || folder.uri.scheme !== "file") return;
    const dir = path.join(os.homedir(), ".auto-router");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "active-workspace.json");
    fs.writeFileSync(file, JSON.stringify({ ws: folder.uri.fsPath, ts: Date.now() }), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); fs.chmodSync(dir, 0o700); } catch {}
  } catch {}
}

function deactivate() {}
module.exports = { activate, deactivate };
