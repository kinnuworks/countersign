import * as vscode from 'vscode';
import { loadAgent, loadModelsConfig, type ModelsConfig } from '../core/config';
import { Countersign } from '../core/countersign';
import type { ApprovalAnswer, RunObserver, RunResult, ToolCallInfo } from '../core/forge';
import { proposalFromCall, recordCommand, recordReview, type PendingProposal } from '../core/proposals';
import type { ContextPack } from '../core/retriever';
import { AgentPanel, type FromWebview } from './panel';
import { ReviewManager } from './review';
import { VscodeWorkspace } from './vscodeWorkspace';
import { startDriver } from './driver';

let cs: Countersign | undefined;
let starting: Promise<Countersign> | undefined;
let current: AbortController | undefined;
let lastSessionUrl: string | undefined;
let panel: AgentPanel;
let reviews: ReviewManager;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
/** What the end-to-end test (and the status bar) can read back. */
const state: { running: boolean; last?: { status: string; model?: string; attempts: RunResult['attempts']; error?: string }; statuses: string[] } = { running: false, statuses: [] };

function cfg() {
  return vscode.workspace.getConfiguration('countersign');
}

function rootFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

export async function activate(ctx: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Countersign');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = '$(shield) Countersign';
  status.command = 'countersign.agent.focus';
  status.show();
  const folder = rootFolder();
  reviews = new ReviewManager(folder?.uri ?? vscode.Uri.file('/'));
  reviews.register(ctx);
  panel = new AgentPanel(m => void onPanel(m));
  reviews.onState.event(s => panel.post({ type: 'review', snapshot: s }));

  ctx.subscriptions.push(
    output,
    status,
    vscode.window.registerWebviewViewProvider(AgentPanel.id, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('countersign.inlineEdit', () => inlineEdit(ctx)),
    // For scripted runs (tests, recordings): same path as the keybinding, with the instruction given.
    vscode.commands.registerCommand('countersign.inlineEditWith', (instruction: string) => inlineEdit(ctx, instruction)),
    vscode.commands.registerCommand('countersign.state', () => ({ ...state, review: reviews.snapshot(), connected: !!cs, journal: cs?.journal.all().map(c => ({ id: c.id, label: c.label, undone: c.undone })) ?? [] })),
    vscode.commands.registerCommand('countersign.cancel', () => cancelRun('Stopped by you')),
    vscode.commands.registerCommand('countersign.undo', () => undo()),
    vscode.commands.registerCommand('countersign.openSession', () => openSession()),
    vscode.commands.registerCommand('countersign.agentRequest', (text: string) => agentRun(ctx, text)),
    vscode.commands.registerCommand('countersign.reconnect', async () => {
      // Let an in-flight start finish first, so its MCP registration cannot land after ours.
      await starting?.catch(() => undefined);
      await cs?.stop();
      cs = undefined;
      starting = undefined;
      await ensure(ctx);
    }),
    { dispose: () => void cs?.stop() },
  );
  void vscode.commands.executeCommand('setContext', 'countersign.running', false);
  if (folder) void ensure(ctx).catch(() => undefined);
  startDriver(ctx, {
    state: () => ({ running: state.running, review: reviews.snapshot() }),
    hasPendingCommand: () => pendingCommands.size > 0,
    answerCommand: allow => {
      const [id, fn] = [...pendingCommands.entries()].pop() ?? [];
      if (id && fn) {
        fn(allow);
        panel.post({ type: 'commandDecided', id, allow });
      }
    },
    decide: (file, n, decision) => {
      const f = reviews.snapshot()?.files[file];
      const h = f?.hunks[n - 1];
      if (f && h) reviews.decide(f.key, h.id, decision);
    },
    typeInline: async (text, cps) => {
      void vscode.commands.executeCommand('countersign.inlineEdit');
      for (let i = 0; i < 40 && !openBox; i++) await new Promise(r => setTimeout(r, 50));
      const box = openBox;
      if (!box) throw new Error('inline edit box did not open');
      for (let i = 1; i <= text.length; i++) {
        box.value = text.slice(0, i);
        await new Promise(r => setTimeout(r, 1000 / cps));
      }
      await new Promise(r => setTimeout(r, 400));
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    },
    typeAgent: async (text, cps) => {
      await panel.reveal();
      panel.post({ type: 'typeAndSend', text, cps });
    },
  });
}

export async function deactivate() {
  current?.abort();
  await cs?.stop();
}

async function modelsConfig(ctx: vscode.ExtensionContext): Promise<ModelsConfig> {
  const folder = rootFolder();
  // The workspace can carry its own countersign.models.json; otherwise the extension's copy is used.
  for (const dir of [folder?.uri.fsPath, ctx.extensionPath]) {
    if (!dir) continue;
    try {
      return await loadModelsConfig(dir);
    } catch {
      /* next */
    }
  }
  throw new Error('countersign.models.json not found');
}

async function ensure(ctx: vscode.ExtensionContext): Promise<Countersign> {
  if (cs) return cs;
  if (starting) return starting;
  starting = (async () => {
    const folder = rootFolder();
    if (!folder) throw new Error('Open a folder first.');
    const mc = await modelsConfig(ctx);
    const url = cfg().get<string>('trueforgeUrl') || mc.trueforge.baseUrl;
    const chainSetting = cfg().get<string[]>('models') ?? [];
    const chain = chainSetting.length ? chainSetting : mc.chain;
    const retry = { retries: cfg().get<number>('retries') ?? mc.retry.retries, baseDelayMs: mc.retry.baseDelayMs };
    const ws = new VscodeWorkspace(folder.uri.fsPath, folder.uri);
    const instance = new Countersign(ws, { coder: await loadAgent(ctx.extensionPath, 'countersign-coder'), inline: await loadAgent(ctx.extensionPath, 'countersign-inline') }, chain, retry, url, {
      onActivity: a => output.appendLine(`tool ${a.tool} ${JSON.stringify(a.args)} -> ${a.summary}`),
      onContext: (pack, by) => postContext(pack, by),
    });
    instance.journal.listeners.push(sets => panel.post({ type: 'changes', items: sets.map(s => ({ id: s.id, label: s.label, undone: s.undone })) }));
    if (!(await instance.forge.health())) {
      panel.post({ type: 'config', chain, connected: false, url, note: `TrueForge is not running at ${url}. Start it with: OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest` });
      throw new Error(`TrueForge is not reachable at ${url}`);
    }
    await instance.start();
    // Keep the index in step with changes made outside Countersign (git checkout, other editors).
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
    const reindex = async (uri: vscode.Uri) => {
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (/(^|\/)(\.git|node_modules|\.venv|__pycache__)\//.test(rel)) return;
      instance.retriever.update(rel, await instance.ws.readFile(rel));
    };
    watcher.onDidChange(reindex);
    watcher.onDidCreate(reindex);
    watcher.onDidDelete(uri => instance.retriever.update(vscode.workspace.asRelativePath(uri, false), null));
    ctx.subscriptions.push(watcher);
    const available = new Set((await instance.forge.models()).map(m => m.name));
    const missing = chain.filter(m => !available.has(m));
    panel.post({ type: 'config', chain, connected: true, url, note: missing.length ? `Not configured in TrueForge: ${missing.join(', ')}` : undefined });
    if (missing.length) panel.post({ type: 'status', kind: 'warn', text: `These models are not configured in TrueForge yet: ${missing.join(', ')}. Run the setup script (README) or change countersign.models.` });
    output.appendLine(`connected to ${url}; MCP tools on 127.0.0.1:${instance.tools?.port}; indexed ${instance.retriever.size.files} files`);
    cs = instance;
    return instance;
  })();
  try {
    return await starting;
  } catch (e) {
    starting = undefined;
    throw e;
  }
}

function postContext(pack: ContextPack, by: 'auto' | 'agent') {
  panel.post({
    type: 'context',
    by,
    used: pack.usedTokens,
    budget: pack.budgetTokens,
    indexed: pack.indexedFiles,
    files: pack.files.map(f => ({ path: f.path, why: f.reasons.join('; '), tokens: f.tokens })),
    omitted: pack.omitted.length,
    omittedSample: pack.omitted.slice(0, 4).map(o => o.path),
  });
}

function setRunning(on: boolean, label = '') {
  state.running = on;
  void vscode.commands.executeCommand('setContext', 'countersign.running', on);
  panel.post({ type: 'running', running: on });
  status.text = on ? `$(sync~spin) Countersign: ${label} · Esc to stop` : '$(shield) Countersign';
}

/** Approvals from TrueForge become a review in the editor; the answers go back as the approval. */
function observer(mode: 'agent' | 'inline'): RunObserver {
  let draftThrottle = 0;
  return {
    onStatus: (text, kind) => {
      state.statuses.push(`${kind}: ${text}`);
      panel.post({ type: 'status', text, kind });
      if (kind === 'warn') void vscode.window.setStatusBarMessage(`Countersign: ${text}`, 6000);
    },
    onSession: s => {
      lastSessionUrl = s.url;
      panel.post({ type: 'session', url: s.url, model: s.model });
    },
    onDelta: (thread, text) => panel.post({ type: 'delta', thread, text }),
    onToolDraft: (thread, name, args) => {
      const now = Date.now();
      if (now - draftThrottle < 60 || !['propose_edit', 'create_file'].includes(name)) return;
      draftThrottle = now;
      panel.post({ type: 'draft', thread, name, preview: args });
    },
    onThread: t => panel.post({ type: 'thread', thread: t.threadId, title: t.title, instructions: t.instructions, done: t.done, status: t.status }),
    onToolResult: (call, content) => {
      if (!call) return;
      const a = call.args;
      const detail = String(a.path ?? a.query ?? a.pattern ?? a.name ?? a.command ?? a.dir ?? (call.name === 'create_sub_agent' ? a.name ?? '' : '')).slice(0, 90);
      const first = content.split('\n')[0].slice(0, 110);
      panel.post({ type: 'tool', thread: call.threadId, name: call.name, detail, result: first });
    },
    onApprovals: async (calls: ToolCallInfo[], signal: AbortSignal) => {
      const answers: ApprovalAnswer[] = [];
      const props: { call: ToolCallInfo; p: PendingProposal }[] = [];
      for (const c of calls) {
        if (c.name === 'run_command') {
          const allow = await askCommand(c, signal);
          if (allow) recordCommand(cs!.book, c);
          panel.post({ type: 'status', kind: 'info', text: `${allow ? 'Allowed' : 'Denied'}: ${String(c.args.command)}` });
          answers.push({ toolCallId: c.id, threadId: c.threadId, allow, reason: allow ? undefined : 'The user denied this command.' });
          continue;
        }
        const r = await proposalFromCall(cs!.ws, c);
        if (!r.ok) {
          panel.post({ type: 'status', kind: 'info', text: `Sent back to the model: ${r.reason}` });
          answers.push({ toolCallId: c.id, threadId: c.threadId, allow: false, reason: r.reason });
          continue;
        }
        props.push({ call: c, p: r.p });
      }
      if (props.length) {
        status.text = `$(diff) Countersign: review ${props.length} file${props.length > 1 ? 's' : ''}`;
        const accepted = await reviews.review(
          props.map(x => x.p),
          signal,
        );
        props.forEach((x, i) => {
          const d = recordReview(cs!.book, x.p, accepted[i]);
          answers.push({ toolCallId: x.call.id, threadId: x.call.threadId, allow: d.allow, reason: d.reason });
          panel.post({ type: 'status', kind: d.allow ? 'ok' : 'info', text: d.allow ? `Approved ${accepted[i].size}/${x.p.file.hunks.length} hunks of ${x.p.file.path}; TrueForge runs the write.` : d.reason! });
        });
        status.text = `$(sync~spin) Countersign: ${mode} · Esc to stop`;
      }
      // Keep TrueForge's order: one answer per call it asked about.
      return calls.map(c => answers.find(a => a.toolCallId === c.id) ?? { toolCallId: c.id, threadId: c.threadId, allow: false, reason: 'no decision' });
    },
  };
}

async function finish(result: RunResult, startedClean: string | null) {
  const instance = cs!;
  state.last = { status: result.status, model: result.model, attempts: result.attempts, error: result.error };
  const st = await instance.gitStatus();
  if (result.status === 'cancelled') {
    panel.post({ type: 'status', kind: 'warn', text: 'Cancelled. The model stopped, open reviews were dropped, and no half-applied edits exist (writes only happen inside an approved, complete tool call).' });
  }
  if (result.status === 'error') panel.post({ type: 'status', kind: 'error', text: `Run failed: ${result.error}. Nothing was changed by the failed attempt.` });
  if (result.attempts.length > 1) panel.post({ type: 'status', kind: 'info', text: `Attempts: ${result.attempts.map(a => `${a.model} (${a.outcome.slice(0, 60)})`).join(' → ')}` });
  if (st != null) {
    const changedByRun = st !== startedClean;
    panel.post({ type: 'git', clean: !st, text: st ? `git status --porcelain:\n${st}${changedByRun ? '' : '\n(unchanged by this run)'}` : 'git status: clean, no files changed' });
  }
}

async function agentRun(ctx: vscode.ExtensionContext, text: string) {
  if (current) return;
  let instance: Countersign;
  try {
    instance = await ensure(ctx);
  } catch (e) {
    panel.post({ type: 'status', kind: 'error', text: (e as Error).message });
    return;
  }
  const pinned = [...text.matchAll(/@([\w./-]+)/g)]
    .map(m => m[1])
    .flatMap(t => (instance.retriever.files.has(t) ? [t] : instance.retriever.findSymbol(t).slice(0, 1).map(h => h.file)));
  const open = vscode.window.visibleTextEditors.map(e => vscode.workspace.asRelativePath(e.document.uri, false));
  panel.post({ type: 'user', text, mode: 'agent' });
  current = new AbortController();
  setRunning(true, 'agent');
  const before = await instance.gitStatus();
  try {
    const r = await instance.runAgent(text, observer('agent'), current.signal, { pinned, open, budgetTokens: cfg().get<number>('contextBudget') ?? 10000 });
    await finish(r, before);
  } finally {
    current = undefined;
    setRunning(false);
  }
}

async function inlineEdit(ctx: vscode.ExtensionContext, given?: string) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== 'file') return void vscode.window.showWarningMessage('Countersign: select code in a file first.');
  if (current) return void vscode.window.showWarningMessage('Countersign is already running; press Esc to stop it.');
  const sel = ed.selection.isEmpty ? new vscode.Selection(ed.selection.active.line, 0, ed.selection.active.line, 0) : ed.selection;
  const instruction = given ?? (await askInstruction(`${vscode.workspace.asRelativePath(ed.document.uri)}:${sel.start.line + 1}-${sel.end.line + 1}`));
  if (!instruction) return;
  let instance: Countersign;
  try {
    instance = await ensure(ctx);
  } catch (e) {
    void vscode.window.showErrorMessage(`Countersign: ${(e as Error).message}`);
    panel.post({ type: 'status', kind: 'error', text: (e as Error).message });
    return;
  }
  const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  panel.post({ type: 'user', text: `${rel}:${sel.start.line + 1}-${endLine} · ${instruction}`, mode: 'inline' });
  void panel.reveal();
  current = new AbortController();
  setRunning(true, 'inline edit');
  const before = await instance.gitStatus();
  try {
    const r = await instance.runInline({ path: rel, startLine: sel.start.line + 1, endLine, instruction }, observer('inline'), current.signal);
    await finish(r, before);
  } finally {
    current = undefined;
    setRunning(false);
  }
}

/** The TrueForge session (turns, tool calls, subagents) in a tab next to the code, or the browser if Simple Browser is off. */
async function openSession() {
  if (!lastSessionUrl) return void vscode.window.showInformationMessage('Countersign: no TrueForge session yet.');
  try {
    await vscode.commands.executeCommand('simpleBrowser.show', lastSessionUrl);
  } catch {
    await vscode.env.openExternal(vscode.Uri.parse(lastSessionUrl));
  }
}

let openBox: vscode.InputBox | undefined;
const pendingCommands = new Map<string, (allow: boolean) => void>();

/** Command approvals live in the panel, next to the transcript that explains them. */
function askCommand(c: ToolCallInfo, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    pendingCommands.set(c.id, allow => {
      pendingCommands.delete(c.id);
      resolve(allow);
    });
    panel.post({ type: 'approveCommand', id: c.id, command: String(c.args.command ?? ''), explanation: String(c.args.explanation ?? '') });
    status.text = '$(terminal) Countersign: approve a command';
    signal.addEventListener('abort', () => {
      pendingCommands.delete(c.id);
      reject(new Error('cancelled'));
    }, { once: true });
  });
}

/** The inline-edit prompt. A created InputBox (not showInputBox) so the demo driver can type into it visibly. */
function askInstruction(where: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const box = vscode.window.createInputBox();
    box.title = 'Countersign: inline edit';
    box.prompt = `Instruction for ${where}. Enter to send, Esc to cancel.`;
    box.placeholder = 'e.g. handle empty input and update the docstring';
    box.ignoreFocusOut = true;
    let done = false;
    box.onDidAccept(() => {
      done = true;
      const v = box.value.trim();
      box.hide();
      resolve(v || undefined);
    });
    box.onDidHide(() => {
      openBox = undefined;
      box.dispose();
      if (!done) resolve(undefined);
    });
    openBox = box;
    box.show();
  });
}

function cancelRun(reason: string) {
  if (!current) return;
  panel.post({ type: 'status', kind: 'warn', text: `${reason}. Cancelling the TrueForge turn…` });
  reviews.cancel();
  current.abort();
}

async function undo(id?: string) {
  if (!cs) return;
  const r = await cs.undo(id);
  panel.post({ type: 'status', kind: r.ok ? 'ok' : 'warn', text: r.message });
  if (r.ok) {
    const st = await cs.gitStatus();
    if (st != null) panel.post({ type: 'git', clean: !st, text: st ? `git status --porcelain:\n${st}` : 'git status: clean, no files changed' });
  }
}

async function onPanel(m: FromWebview) {
  switch (m.type) {
    case 'send':
      return vscode.commands.executeCommand('countersign.agentRequest', m.text);
    case 'stop':
      return cancelRun('Stopped by you');
    case 'undo':
      return undo(m.id);
    case 'hunk':
      return reviews.decide(m.key, m.id, m.decision);
    case 'fileAll':
      return reviews.decideFile(m.key, m.decision);
    case 'all':
      return reviews.decideEverything(m.decision);
    case 'openDiff':
      return reviews.openByKey(m.key);
    case 'commandAnswer':
      pendingCommands.get(m.id)?.(m.allow);
      panel.post({ type: 'commandDecided', id: m.id, allow: m.allow });
      return;
    case 'openSession':
      return openSession();
    case 'mention': {
      if (!cs) return;
      const q = m.query.toLowerCase();
      const files = [...cs.retriever.files.keys()].filter(f => f.toLowerCase().includes(q)).slice(0, 8);
      const syms = q.length >= 2 ? cs.retriever.symbolsFor(q, 8) : [];
      panel.post({
        type: 'mentions',
        items: [...files.map(f => ({ label: f, insert: `@${f}`, detail: 'file' })), ...syms.map(s => ({ label: s.name, insert: `@${s.name.split('.').pop()}`, detail: `${s.file}:${s.line}` }))],
      });
      return;
    }
  }
}
