// auto-router companion: watches data/context-state.json written by the gateway.
//  - status bar: profile → model, context %, quota state
//  - when the gateway sets action "new_chat" (context nearly full) it opens a new chat that continues from the
//    session memory file (.auto-router/memory/<session>.md), sending the prompt automatically if allowed.
const vscode = require("vscode");
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
  item.text = `$(circuit-board) ${state.mode || "?"} → ${state.model || "?"} · ctx ${ctx}%${qWarn}`;
  item.backgroundColor = ctx >= 85 || q.state === "critical" || q.state === "exhausted"
    ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  const md = new vscode.MarkdownString(
    `**auto-router** · session \`${state.session}\`\n\n` +
    `- profile: auto-${state.mode}\n- model: ${state.model}\n- models used: ${(state.trail || []).join(" → ")}\n` +
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
      && vscode.workspace.getConfiguration("autoRouter").get("autoNewChat")) {
    handled.add(key);
    openNewChat(s, "context nearly full");
  }
}

function activate(context) {
  log = vscode.window.createOutputChannel("auto-router");
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "autoRouter.showStatus";
  item.show();
  state = readState();
  render();
  publishWorkspace();
  context.subscriptions.push(vscode.window.onDidChangeWindowState((w) => { if (w.focused) publishWorkspace(); }));
  fs.watchFile(statePath(), { interval: 1000 }, onChange);
  context.subscriptions.push(item, log, { dispose: () => fs.unwatchFile(statePath()) },
    vscode.commands.registerCommand("autoRouter.showStatus", () => {
      log.appendLine(JSON.stringify(readState(), null, 2)); log.show(true);
    }),
    vscode.commands.registerCommand("autoRouter.openMemory", async () => {
      const s = readState();
      if (!s || !s.workspace || !s.memory_file) return vscode.window.showInformationMessage("auto-router: no session memory yet.");
      vscode.window.showTextDocument(vscode.Uri.file(path.join(s.workspace, s.memory_file)));
    }),
    vscode.commands.registerCommand("autoRouter.continueInNewChat", () => {
      const s = readState();
      if (s) openNewChat(s, "manual");
    }));
  log.appendLine(`auto-router companion active; watching ${statePath()}`);
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
