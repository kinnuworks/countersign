import * as vscode from 'vscode';

export type ToWebview =
  | { type: 'status'; text: string; kind: 'info' | 'warn' | 'error' | 'ok' }
  | { type: 'user'; text: string; mode: 'agent' | 'inline' }
  | { type: 'context'; by: 'auto' | 'agent'; used: number; budget: number; indexed: number; files: { path: string; why: string; tokens: number }[]; omitted: number; omittedSample: string[] }
  | { type: 'delta'; thread: string; text: string }
  | { type: 'draft'; thread: string; name: string; preview: string }
  | { type: 'tool'; thread: string; name: string; detail: string; result?: string }
  | { type: 'thread'; thread: string; title: string; instructions?: string; done?: boolean; status?: string }
  | { type: 'review'; snapshot: unknown }
  | { type: 'session'; url: string; model: string }
  | { type: 'running'; running: boolean }
  | { type: 'git'; text: string; clean: boolean }
  | { type: 'changes'; items: { id: string; label: string; undone: boolean }[] }
  | { type: 'mentions'; items: { label: string; insert: string; detail: string }[] }
  | { type: 'config'; chain: string[]; connected: boolean; url: string; note?: string }
  | { type: 'typeAndSend'; text: string; cps: number }
  | { type: 'approveCommand'; id: string; command: string; explanation: string }
  | { type: 'commandDecided'; id: string; allow: boolean };

export type FromWebview =
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'undo'; id?: string }
  | { type: 'hunk'; key: string; id: string; decision: 'accepted' | 'rejected' | 'pending' }
  | { type: 'fileAll'; key: string; decision: 'accepted' | 'rejected' }
  | { type: 'all'; decision: 'accepted' | 'rejected' }
  | { type: 'openDiff'; key: string }
  | { type: 'openSession' }
  | { type: 'mention'; query: string }
  | { type: 'ready' }
  | { type: 'commandAnswer'; id: string; allow: boolean };

export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly id = 'countersign.agent';
  private view?: vscode.WebviewView;
  private queue: ToWebview[] = [];
  private ready = false;

  constructor(private readonly onMessage: (m: FromWebview) => void) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(nonce());
    view.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === 'ready') {
        this.ready = true;
        for (const q of this.queue.splice(0)) void view.webview.postMessage(q);
      }
      this.onMessage(m);
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  post(m: ToWebview) {
    if (this.view && this.ready) void this.view.webview.postMessage(m);
    else {
      this.queue.push(m);
      if (this.queue.length > 400) this.queue.splice(0, this.queue.length - 400);
    }
  }

  async reveal() {
    await vscode.commands.executeCommand('countersign.agent.focus');
  }
}

function nonce() {
  let s = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function html(n: string): string {
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  :root { --gap: 8px; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 6px 120px; margin: 0; }
  header { position: sticky; top: 0; background: var(--vscode-sideBar-background); padding: 6px 0; z-index: 2; border-bottom: 1px solid var(--vscode-panel-border); }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .chain { font-size: 11px; opacity: .85; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--vscode-testing-iconFailed); }
  .dot.ok { background: var(--vscode-testing-iconPassed); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 3px 9px; border-radius: 3px; cursor: pointer; font-size: 12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-foreground); }
  button:disabled { opacity: .4; cursor: default; }
  #log { display: flex; flex-direction: column; gap: var(--gap); padding-top: var(--gap); }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 8px; background: var(--vscode-editor-background); }
  .user { border-left: 3px solid var(--vscode-textLink-foreground); }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin-bottom: 3px; }
  .msg { white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; }
  .status { font-size: 12px; padding: 4px 8px; border-radius: 3px; }
  .status.warn { background: var(--vscode-inputValidation-warningBackground); }
  .status.error { background: var(--vscode-inputValidation-errorBackground); }
  .status.ok { background: color-mix(in srgb, var(--vscode-testing-iconPassed) 22%, transparent); }
  .status.info { opacity: .85; }
  .tool { font-family: var(--vscode-editor-font-family); font-size: 11.5px; opacity: .9; padding: 1px 0 1px 8px; border-left: 2px solid var(--vscode-panel-border); }
  .tool .res { opacity: .7; }
  .thread { border-left: 3px solid var(--vscode-charts-purple); }
  .thread .tool { margin-left: 4px; }
  .budget { height: 6px; background: var(--vscode-input-background); border-radius: 3px; overflow: hidden; margin: 4px 0; }
  .budget > div { height: 100%; background: var(--vscode-charts-blue); }
  .file { font-family: var(--vscode-editor-font-family); font-size: 12px; margin-top: 4px; }
  .why { font-size: 11.5px; opacity: .8; margin-left: 10px; }
  .hunk { margin-top: 6px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
  .hunk.accepted { border-color: var(--vscode-testing-iconPassed); }
  .hunk.rejected { opacity: .5; }
  .hunk-head { display: flex; justify-content: space-between; align-items: center; padding: 3px 6px; background: var(--vscode-editorWidget-background); font-size: 12px; gap: 6px; }
  pre.diff { margin: 0; padding: 4px 6px; font-family: var(--vscode-editor-font-family); font-size: 11.5px; overflow-x: auto; max-height: 220px; }
  .add { background: var(--vscode-diffEditor-insertedLineBackground); display: block; }
  .del { background: var(--vscode-diffEditor-removedLineBackground); display: block; }
  .draft { font-family: var(--vscode-editor-font-family); font-size: 11.5px; white-space: pre-wrap; max-height: 260px; overflow: auto; background: var(--vscode-textCodeBlock-background); padding: 4px 6px; border-radius: 3px; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 6px; background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border); }
  textarea { width: 100%; box-sizing: border-box; min-height: 54px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; font-size: 13px; padding: 5px; border-radius: 3px; }
  #mentions { position: absolute; bottom: 100%; left: 6px; right: 6px; background: var(--vscode-editorSuggestWidget-background); border: 1px solid var(--vscode-editorSuggestWidget-border); max-height: 180px; overflow: auto; display: none; }
  #mentions div { padding: 3px 6px; cursor: pointer; font-size: 12px; font-family: var(--vscode-editor-font-family); }
  #mentions div.sel, #mentions div:hover { background: var(--vscode-editorSuggestWidget-selectedBackground); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .muted { opacity: .7; font-size: 11.5px; }
  code { font-family: var(--vscode-editor-font-family); font-size: 0.92em; background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
</style></head>
<body>
<header>
  <div class="row"><span id="dot" class="dot"></span><b>Countersign</b><span id="conn" class="muted">connecting to TrueForge…</span></div>
  <div class="row chain" id="chain"></div>
  <div class="row" style="margin-top:4px">
    <button id="stop" class="danger" disabled title="Stop the run (Esc)">■ Stop</button>
    <button id="undo" class="secondary" disabled>↶ Undo last change</button>
    <button id="session" class="secondary" disabled>Open TrueForge session</button>
  </div>
</header>
<div id="log"></div>
<footer>
  <div id="mentions"></div>
  <textarea id="input" placeholder="Ask for a change. @file or @symbol to pin context. Enter to send, Shift+Enter for a new line."></textarea>
  <div class="row" style="justify-content:space-between"><span class="muted" id="hint">Agent mode: one request, Countersign finds the files.</span><button id="send">Send</button></div>
</footer>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const log = $('log');
let running = false, assistant = null, assistantThread = null, review = null, draftEl = null;
const threads = {};
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function add(el) { log.appendChild(el); window.scrollTo(0, document.body.scrollHeight); return el; }
function div(cls, html) { const d = document.createElement('div'); d.className = cls; if (html !== undefined) d.innerHTML = html; return d; }
// Minimal, escape-first markdown for model text: code fences, inline code, bold, bullets, headings.
function md(src) {
  const parts = String(src).split(/\n?\x60\x60\x60[\w-]*\n?/);
  return parts.map((p, i) => {
    if (i % 2) return '<pre class="draft">' + esc(p) + '</pre>';
    return esc(p)
      .replace(/\x60([^\x60\n]+)\x60/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,4} (.+)$/gm, '<b>$1</b>')
      .replace(/^[-*] (.+)$/gm, '• $1');
  }).join('');
}
function finishAssistant() { if (assistant && assistant.dataset.raw) { assistant.innerHTML = md(assistant.dataset.raw); } }
function container(thread) { return thread && thread !== 'main' && threads[thread] ? threads[thread].body : log; }

function partialNewText(args) {
  // Show the edit as it is being written: pull new_text / content out of the half-finished JSON.
  const m = /"(new_text|content)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)/g; let last = null, x;
  while ((x = m.exec(args))) last = x[2];
  if (last == null) return null;
  return last.replace(/\\\\n/g, '\\n').replace(/\\\\t/g, '\\t').replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\\\');
}

window.addEventListener('message', ev => {
  const m = ev.data;
  switch (m.type) {
    case 'config': {
      $('dot').className = 'dot' + (m.connected ? ' ok' : '');
      $('conn').textContent = m.connected ? 'TrueForge ' + m.url : (m.note || 'TrueForge not reachable at ' + m.url);
      $('chain').innerHTML = 'Models: ' + m.chain.map((c, i) => (i ? ' → ' : '') + '<span>' + esc(c) + '</span>').join('') + (m.chain.length > 1 ? ' <span class="muted">(fallback in order)</span>' : '');
      break;
    }
    case 'running': running = m.running; $('stop').disabled = !running; $('send').disabled = running; if (!running) { finishAssistant(); assistant = null; draftEl = null; } break;
    case 'user': { finishAssistant(); assistant = null; const c = add(div('card user')); c.innerHTML = '<div class="label">' + (m.mode === 'inline' ? 'Inline edit' : 'You') + '</div><div class="msg">' + esc(m.text) + '</div>'; break; }
    case 'status': add(div('status ' + m.kind, esc(m.text))); finishAssistant(); assistant = null; break;
    case 'session': $('session').disabled = false; add(div('status info', 'TrueForge session started on <b>' + esc(m.model) + '</b> · <a data-act="session">open session</a>')); break;
    case 'context': {
      const pct = Math.min(100, Math.round(100 * m.used / m.budget));
      const c = add(div('card'));
      c.innerHTML = '<div class="label">' + (m.by === 'auto' ? 'Context chosen automatically' : 'Agent asked for more context') + '</div>'
        + '<div class="muted">' + m.files.length + ' files · ' + m.used.toLocaleString() + ' of ' + m.budget.toLocaleString() + ' tokens · searched ' + m.indexed + ' files</div>'
        + '<div class="budget"><div style="width:' + pct + '%"></div></div>'
        + (m.by === 'auto'
          ? m.files.map(f => '<div class="file">' + esc(f.path) + ' <span class="muted">' + f.tokens + ' tok</span></div><div class="why">' + esc(f.why) + '</div>').join('')
          : '<div class="file">' + m.files.map(f => esc(f.path)).join(', ') + '</div>')
        + (m.omitted ? '<div class="muted" style="margin-top:4px">Left out: ' + m.omitted + ' files (' + m.omittedSample.map(esc).join(', ') + (m.omitted > m.omittedSample.length ? ', …' : '') + ')</div>' : '');
      finishAssistant(); assistant = null; break;
    }
    case 'thread': {
      if (m.done) { const t = threads[m.thread]; if (t) t.head.innerHTML = '↳ subagent <b>' + esc(t.title) + '</b> · ' + esc(m.status || 'done'); break; }
      const c = add(div('card thread'));
      const head = div('label', '↳ subagent <b>' + esc(m.title) + '</b> · running');
      c.appendChild(head);
      if (m.instructions) c.appendChild(div('muted', esc(m.instructions.slice(0, 280)) + (m.instructions.length > 280 ? '…' : '')));
      const body = div(''); c.appendChild(body);
      threads[m.thread] = { head, body, title: m.title };
      finishAssistant(); assistant = null; break;
    }
    case 'delta': {
      if (!assistant || assistantThread !== m.thread) { finishAssistant(); const c = div('msg'); c.dataset.raw = ''; container(m.thread).appendChild(c); assistant = c; assistantThread = m.thread; }
      assistant.dataset.raw += m.text; assistant.textContent = assistant.dataset.raw; window.scrollTo(0, document.body.scrollHeight); break;
    }
    case 'draft': {
      const t = partialNewText(m.preview);
      if (t == null) break;
      if (!draftEl) { const c = div('card'); c.appendChild(div('label', 'Drafting ' + esc(m.name) + '…')); draftEl = div('draft'); c.appendChild(draftEl); container(m.thread).appendChild(c); }
      draftEl.textContent = t; draftEl.scrollTop = draftEl.scrollHeight; window.scrollTo(0, document.body.scrollHeight); break;
    }
    case 'tool': {
      draftEl = null;
      const d = div('tool', '⚙ <b>' + esc(m.name) + '</b> ' + esc(m.detail) + (m.result ? ' <span class="res">→ ' + esc(m.result) + '</span>' : ''));
      container(m.thread).appendChild(d); finishAssistant(); assistant = null; window.scrollTo(0, document.body.scrollHeight); break;
    }
    case 'review': renderReview(m.snapshot); break;
    case 'git': add(div('status ' + (m.clean ? 'ok' : 'info'), esc(m.text))); break;
    case 'changes': { const live = m.items.filter(i => !i.undone); $('undo').disabled = !live.length; $('undo').title = live.length ? 'Undo: ' + live[live.length - 1].label : ''; break; }
    case 'mentions': showMentions(m.items); break;
    case 'approveCommand': {
      const c = add(div('card cmd'));
      c.id = 'cmd-' + m.id;
      c.innerHTML = '<div class="label">Run this command? TrueForge is waiting on this approval.</div><pre class="draft">$ ' + esc(m.command) + '</pre>'
        + (m.explanation ? '<div class="why">' + esc(m.explanation) + '</div>' : '')
        + '<div class="row" style="margin-top:4px"><button data-act="cmd" data-id="' + esc(m.id) + '" data-allow="1">Allow</button><button class="secondary" data-act="cmd" data-id="' + esc(m.id) + '" data-allow="0">Deny</button></div>';
      finishAssistant(); assistant = null; break;
    }
    case 'commandDecided': {
      const c = document.getElementById('cmd-' + m.id);
      if (c) c.querySelectorAll('button').forEach(b => { b.disabled = true; if ((b.dataset.allow === '1') === m.allow) b.textContent = (m.allow ? '✓ Allowed' : '✗ Denied'); });
      break;
    }
    case 'typeAndSend': {
      input.focus(); input.value = '';
      let i = 0;
      const tick = () => { i++; input.value = m.text.slice(0, i); if (i < m.text.length) setTimeout(tick, 1000 / m.cps); else setTimeout(send, 450); };
      tick(); break;
    }
  }
});

function renderReview(s) {
  if (!s) { if (review) { review.querySelectorAll('button').forEach(b => b.disabled = true); review.querySelector('.label').textContent = 'Review closed'; } review = null; return; }
  if (!review) { review = add(div('card')); }
  const total = s.files.reduce((a, f) => a + f.hunks.length, 0);
  const pending = s.files.reduce((a, f) => a + f.hunks.filter(h => h.state === 'pending').length, 0);
  let h = '<div class="label">Review · ' + s.files.length + ' file' + (s.files.length > 1 ? 's' : '') + ' · ' + pending + ' of ' + total + ' hunks pending</div>'
    + '<div class="row"><button data-act="all" data-d="accepted">✓ Accept all</button><button class="secondary" data-act="all" data-d="rejected">✗ Reject all</button><span class="muted">Nothing is written until you decide. TrueForge is waiting on this approval.</span></div>';
  for (const f of s.files) {
    h += '<div class="file" style="margin-top:8px"><b>' + esc(f.path) + '</b>' + (f.isNew ? ' <span class="muted">(new file)</span>' : '') + ' · <a data-act="diff" data-key="' + f.key + '">open diff</a></div>';
    if (f.explanation) h += '<div class="why">' + esc(f.explanation) + '</div>';
    for (const k of f.hunks) {
      h += '<div class="hunk ' + k.state + '"><div class="hunk-head"><span>Hunk ' + k.n + ' · ' + esc(k.summary) + '</span><span>'
        + (k.state === 'pending'
          ? '<button data-act="hunk" data-key="' + f.key + '" data-id="' + esc(k.id) + '" data-d="accepted">✓ Accept</button> <button class="secondary" data-act="hunk" data-key="' + f.key + '" data-id="' + esc(k.id) + '" data-d="rejected">✗ Reject</button>'
          : (k.state === 'accepted' ? '✓ accepted' : '✗ rejected') + ' · <a data-act="hunk" data-key="' + f.key + '" data-id="' + esc(k.id) + '" data-d="pending">change</a>')
        + '</span></div><pre class="diff">' + k.lines.map(l => '<span class="' + (l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '') + '">' + esc(l) + '</span>').join('') + '</pre></div>';
    }
  }
  review.innerHTML = h;
  window.scrollTo(0, document.body.scrollHeight);
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const a = t.dataset.act;
  if (a === 'hunk') vscode.postMessage({ type: 'hunk', key: t.dataset.key, id: t.dataset.id, decision: t.dataset.d });
  if (a === 'all') vscode.postMessage({ type: 'all', decision: t.dataset.d });
  if (a === 'diff') vscode.postMessage({ type: 'openDiff', key: t.dataset.key });
  if (a === 'session') vscode.postMessage({ type: 'openSession' });
  if (a === 'cmd') vscode.postMessage({ type: 'commandAnswer', id: t.dataset.id, allow: t.dataset.allow === '1' });
});
$('stop').onclick = () => vscode.postMessage({ type: 'stop' });
$('undo').onclick = () => vscode.postMessage({ type: 'undo' });
$('session').onclick = () => vscode.postMessage({ type: 'openSession' });
const input = $('input');
function send() { const v = input.value.trim(); if (!v || running) return; vscode.postMessage({ type: 'send', text: v }); input.value = ''; hideMentions(); }
$('send').onclick = send;

let mentionItems = [], mentionSel = 0;
function currentMention() { const pos = input.selectionStart; const before = input.value.slice(0, pos); const m = /@([\\w./-]*)$/.exec(before); return m ? { q: m[1], start: pos - m[0].length, end: pos } : null; }
function showMentions(items) { mentionItems = items; mentionSel = 0; const box = $('mentions'); if (!items.length || !currentMention()) { hideMentions(); return; } box.innerHTML = items.map((it, i) => '<div data-i="' + i + '" class="' + (i === 0 ? 'sel' : '') + '">' + esc(it.label) + ' <span class="muted">' + esc(it.detail) + '</span></div>').join(''); box.style.display = 'block'; }
function hideMentions() { $('mentions').style.display = 'none'; mentionItems = []; }
function pickMention(i) { const cm = currentMention(); const it = mentionItems[i]; if (!cm || !it) return; input.value = input.value.slice(0, cm.start) + it.insert + ' ' + input.value.slice(cm.end); hideMentions(); input.focus(); }
$('mentions').addEventListener('mousedown', e => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pickMention(Number(d.dataset.i)); } });
input.addEventListener('input', () => { const cm = currentMention(); if (cm) vscode.postMessage({ type: 'mention', query: cm.q }); else hideMentions(); });
input.addEventListener('keydown', e => {
  if (mentionItems.length && $('mentions').style.display === 'block') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mentionSel = (mentionSel + (e.key === 'ArrowDown' ? 1 : -1) + mentionItems.length) % mentionItems.length; [...$('mentions').children].forEach((c, i) => c.className = i === mentionSel ? 'sel' : ''); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionSel); return; }
    if (e.key === 'Escape') { hideMentions(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape' && running) vscode.postMessage({ type: 'stop' });
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
