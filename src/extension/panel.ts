import * as vscode from 'vscode';
import { FONT_CSS } from './panelFonts';

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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'nonce-${n}';">
<style>${FONT_CSS}</style>
<style>
  /* Tokens. High-contrast themes keep VS Code's own colours; the direction blocks below set the
     dark and light values. Three text sizes: display, reading, small (small is never under 13px). */
  body {
    --bg: var(--vscode-sideBar-background); --surface: var(--vscode-editor-background); --surface-2: var(--vscode-editorWidget-background);
    --ink: var(--vscode-foreground); --text: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground);
    --rule: var(--vscode-panel-border); --edge: var(--vscode-input-border, var(--vscode-contrastBorder, var(--vscode-panel-border)));
    --go: var(--vscode-button-background); --on-go: var(--vscode-button-foreground);
    --btn2: var(--vscode-button-secondaryBackground); --on-btn2: var(--vscode-button-secondaryForeground); --btn2-edge: transparent;
    --stop: var(--vscode-inputValidation-errorBackground); --on-stop: var(--vscode-foreground);
    --signal: var(--vscode-testing-iconPassed); --link: var(--vscode-textLink-foreground);
    --ok: var(--vscode-testing-iconPassed); --warn: var(--vscode-editorWarning-foreground); --err: var(--vscode-errorForeground);
    --chip: var(--vscode-badge-background); --on-chip: var(--vscode-badge-foreground);
    --font-ui: var(--vscode-font-family); --font-display: var(--vscode-font-family); --font-label: var(--vscode-font-family); --font-code: var(--vscode-editor-font-family);
    --fs-d: 18px; --fs-b: 14px; --fs-s: 13px;
    --r-card: 4px; --r-btn: 3px; --pad: 12px;
    --d-weight: 600; --d-track: 0; --label-case: none; --label-track: 0;
  }

  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body { font-family: var(--font-ui); font-size: var(--fs-b); line-height: 1.5; color: var(--text); padding: 0 12px 180px; margin: 0; -webkit-font-smoothing: antialiased; }
  b, strong { color: var(--ink); font-weight: 600; }
  a { color: var(--link); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  code { font-family: var(--font-code); font-size: var(--fs-s); background: var(--surface-2); padding: 0 4px; border-radius: 3px; }
  .muted { color: var(--muted); font-size: var(--fs-s); }

  /* Header: who we are, where we're connected, the model chain, and Stop. */
  header { position: sticky; top: 0; z-index: 3; background: var(--bg); padding: 14px 0 12px; border-bottom: 1px solid var(--rule); }
  .eyebrow { display: flex; align-items: flex-start; gap: 8px; line-height: 1.4; font-family: var(--font-label); font-size: var(--fs-s); color: var(--muted); text-transform: var(--label-case); letter-spacing: var(--label-track); overflow-wrap: anywhere; }
  .wordmark { font-family: var(--font-display); font-size: calc(var(--fs-d) + 2px); font-weight: var(--d-weight); letter-spacing: var(--d-track); color: var(--ink); line-height: 1.15; margin: 6px 0 10px; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 6px 0 10px; }
  .top .wordmark { margin: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; margin-top: 5px; background: var(--err); }
  .dot.ok { background: var(--ok); }
  header.offline #conn { color: var(--err); text-transform: none; letter-spacing: 0; }
  .chain { font-size: var(--fs-s); line-height: 1.95; color: var(--muted); }
  .chain .m { font-family: var(--font-code); font-size: var(--fs-s); color: var(--text); background: var(--surface-2); border: 1px solid var(--rule); padding: 1px 6px; border-radius: var(--r-btn); -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .chain .m.active { color: var(--ink); border-color: var(--signal); box-shadow: inset 3px 0 0 var(--signal); }
  .nw { white-space: nowrap; }
  .chain .arrow { color: var(--muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .actions button { min-height: 28px; }
  header::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--signal); transform-origin: left; transform: scaleX(0); opacity: 0; }
  body.running header::after { opacity: 1; animation: run 1.6s ease-in-out infinite; }
  /* Once a run has started, the transcript is the point: the header and composer shrink so the
     context, review and tool cards get most of the sidebar's height. */
  body:has(#log > :not(.empty)) header { padding: 8px 0 8px; }
  body:has(#log > :not(.empty)) header:not(.offline) .eyebrow { display: none; }
  body:has(#log > :not(.empty)) .top { margin: 0 0 6px; }
  body:has(#log > :not(.empty)) .wordmark { font-size: var(--fs-b); }
  body:has(#log > :not(.empty)) .top button.big { min-height: 24px; }
  body:has(#log > :not(.empty)) .chain { line-height: 1.7; font-size: 11px; }
  body:has(#log > :not(.empty)) .chain .m { font-size: 11px; padding: 0 4px; }
  body:has(#log > :not(.empty)) .actions { margin-top: 6px; gap: 6px; flex-wrap: nowrap; }
  body:has(#log > :not(.empty)) .actions button { min-height: 22px; font-size: 11px; padding: 0 8px; }
  body:has(#log > :not(.empty)) { padding-bottom: 112px; }
  body:has(#log > :not(.empty)) #hint { display: none; }
  body:has(#log > :not(.empty)) .send-row { justify-content: flex-end; margin-top: 6px; }
  body:has(#log > :not(.empty)) #input { min-height: 0; height: 52px; }
  @keyframes run { 0% { transform: scaleX(0); } 60% { transform: scaleX(1); opacity: 1; } 100% { transform: scaleX(1); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { body.running header::after { animation: none; transform: scaleX(1); } }

  /* Buttons */
  button { font-family: var(--font-ui); font-size: var(--fs-s); font-weight: 500; line-height: 1; min-height: 30px; padding: 0 12px; border-radius: var(--r-btn); border: 1px solid transparent; cursor: pointer; background: var(--go); color: var(--on-go); white-space: nowrap; }
  button.secondary { background: var(--btn2); color: var(--on-btn2); border-color: var(--btn2-edge); }
  button.ghost { background: transparent; color: var(--text); border-color: var(--edge); }
  button.danger { background: var(--stop); color: var(--on-stop); }
  button:disabled { opacity: .38; cursor: default; }
  #stop:disabled { background: transparent; color: var(--muted); border-color: var(--edge); }
  button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button.big { min-height: 34px; font-size: var(--fs-b); padding: 0 16px; }

  /* Transcript */
  #log { display: flex; flex-direction: column; gap: 12px; padding-top: 14px; }
  .empty { padding: 28px 4px; }
  .empty .lead { font-family: var(--font-display); font-size: var(--fs-d); font-weight: var(--d-weight); letter-spacing: var(--d-track); color: var(--ink); line-height: 1.3; margin: 0 0 10px; }
  #log:has(> :not(.empty)) .empty { display: none; }
  .card { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--r-card); overflow: hidden; }
  .card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 9px var(--pad); border-bottom: 1px solid var(--rule); background: var(--surface-2); }
  .card-head .title { font-family: var(--font-label); font-size: var(--fs-s); color: var(--ink); font-weight: 600; text-transform: var(--label-case); letter-spacing: var(--label-track); }
  .card-head .meta { font-size: var(--fs-s); color: var(--muted); }
  .card-body { padding: 10px var(--pad) 12px; }
  .avatar { display: none; }
  .msg { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
  .reply { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; color: var(--text); padding: 0 2px; }
  .status { font-size: var(--fs-s); line-height: 1.5; padding: 8px 10px 8px 12px; border-radius: var(--r-btn); border-left: 3px solid var(--rule); background: var(--surface); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); }
  .status.warn { border-left-color: var(--warn); }
  .status.error { border-left-color: var(--err); color: var(--ink); }
  .status.ok { border-left-color: var(--ok); color: var(--ink); }
  .status.info { background: transparent; color: var(--muted); }
  .status.git { font-family: var(--font-code); }
  .tool { font-family: var(--font-code); font-size: var(--fs-s); line-height: 1.5; color: var(--muted); padding: 2px 0 2px 10px; border-left: 2px solid var(--rule); overflow-wrap: anywhere; }
  .tool .tname { color: var(--ink); }
  .thread .tool { margin: 4px 0; }
  .draft { font-family: var(--font-code); font-size: var(--fs-s); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; margin: 0; padding: 8px 10px; background: var(--vscode-textCodeBlock-background, var(--surface-2)); border-radius: var(--r-btn); color: var(--text); }

  /* Context card: the budget first, then every file with its reasons. */
  .budget-row { display: flex; justify-content: space-between; gap: 8px; font-size: var(--fs-s); color: var(--muted); }
  .budget-row b { font-variant-numeric: tabular-nums; }
  .budget { height: 8px; background: var(--surface-2); border: 1px solid var(--rule); border-radius: 99px; overflow: hidden; margin: 6px 0 4px; }
  .budget > div { height: 100%; background: var(--signal); }
  .file { margin-top: 7px; }
  .file-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .path { font-family: var(--font-code); font-size: var(--fs-s); color: var(--ink); overflow-wrap: anywhere; }
  .tok { font-family: var(--font-code); font-size: var(--fs-s); color: var(--muted); white-space: nowrap; }
  .why { font-size: var(--fs-s); color: var(--muted); line-height: 1.45; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .role { display: inline-block; font-family: var(--font-label); font-size: var(--fs-s); line-height: 1.3; padding: 0 6px; border-radius: var(--r-btn); background: var(--chip); color: var(--on-chip); text-transform: var(--label-case); letter-spacing: var(--label-track); margin-right: 6px; }
  .left-out { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--rule); }

  /* Review card: the biggest thing on screen while it waits. */
  .card.review { border-color: var(--signal); }
  .card.review.closed { border-color: var(--rule); }
  .review .lead-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .review .notice { font-size: var(--fs-s); color: var(--text); margin-top: 8px; }
  .rfile { margin-top: 14px; }
  .rfile .file-row { justify-content: flex-start; flex-wrap: wrap; }
  .hunk { margin-top: 8px; border: 1px solid var(--rule); border-radius: var(--r-btn); overflow: hidden; background: var(--bg); }
  .hunk.accepted { border-color: var(--ok); }
  .hunk.rejected { opacity: .55; }
  .hunk-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 6px 8px; padding: 6px 8px 6px 10px; background: var(--surface-2); font-size: var(--fs-s); color: var(--ink); }
  .hunk-head .acts { display: flex; gap: 6px; align-items: center; }
  .decided { font-weight: 600; }
  .accepted .decided { color: var(--ok); }
  .rejected .decided { color: var(--muted); }
  pre.diff { margin: 0; padding: 6px 0; font-family: var(--font-code); font-size: var(--fs-s); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow-y: auto; color: var(--text); }
  pre.diff span { display: block; padding: 0 10px; }
  .add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(155,185,85,.2)); }
  .del { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,.2)); }
  .cmd pre.draft { margin-bottom: 8px; }
  .cmd .lead-actions { display: flex; gap: 8px; margin-top: 10px; }

  /* Input */
  footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 12px 12px; background: var(--bg); border-top: 1px solid var(--rule); }
  textarea { width: 100%; min-height: 86px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--edge); font-family: var(--font-ui); font-size: var(--fs-b); line-height: 1.45; padding: 8px 10px; border-radius: var(--r-btn); }
  textarea::placeholder { color: var(--muted); }
  textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .send-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; }
  #mentions { position: absolute; bottom: 100%; left: 12px; right: 12px; background: var(--vscode-editorSuggestWidget-background); border: 1px solid var(--vscode-editorSuggestWidget-border, var(--edge)); max-height: 200px; overflow: auto; display: none; border-radius: var(--r-btn); }
  #mentions div { padding: 5px 8px; cursor: pointer; font-size: var(--fs-s); font-family: var(--font-code); }
  #mentions div.sel, #mentions div:hover { background: var(--vscode-editorSuggestWidget-selectedBackground); }

  /* ---------- The look: GitHub Copilot's system (Mona Sans, Monaspace Neon caps labels, green go, red Stop) ---------- */
  body.vscode-dark {
    --bg: #0d1117; --surface: #0f1511; --surface-2: #191f1b; --ink: #ffffff; --text: #c9d1cb; --muted: #a4aea6;
    --rule: #262c28; --edge: #6e7781; --go: #08872b; --on-go: #ffffff; --btn2: #262c28; --on-btn2: #ffffff; --btn2-edge: #353d37;
    --stop: #da3633; --on-stop: #ffffff; --signal: #5fed83; --link: #a2daff; --ok: #5fed83; --warn: #e3b341; --err: #ff7b72;
    --chip: #0d3024; --on-chip: #5fed83;
  }
  body.vscode-light {
    --bg: #ffffff; --surface: #ffffff; --surface-2: #f6f8fa; --ink: #1f2328; --text: #1f2328; --muted: #59636e;
    --rule: #d1d9e0; --edge: #818b98; --go: #1f883d; --on-go: #ffffff; --btn2: #f6f8fa; --on-btn2: #1f2328; --btn2-edge: #d1d9e0;
    --stop: #cf222e; --on-stop: #ffffff; --signal: #1a7f37; --link: #0969da; --ok: #1a7f37; --warn: #9a6700; --err: #d1242f;
    --chip: #dafbe1; --on-chip: #116329;
  }
  body {
    --font-ui: 'Mona Sans', var(--vscode-font-family); --font-display: 'Mona Sans', var(--vscode-font-family); --font-label: 'Monaspace Neon', var(--vscode-editor-font-family);
    --r-card: 8px; --r-btn: 6px; --d-weight: 480; --label-case: uppercase; --label-track: 0;
  }
  .caret { display: inline-block; width: .55em; height: 1.05em; margin-left: 6px; vertical-align: -0.18em; background: var(--signal); }
  .card.user { background: transparent; border: 0; align-self: flex-end; max-width: 92%; }
  .card.user .card-head { background: transparent; border: 0; padding: 0 2px 4px; justify-content: flex-end; }
  .card.user .card-body { background: var(--btn2); border-radius: var(--r-btn); padding: 8px 12px; color: var(--ink); }
  .card.review { box-shadow: 0 0 0 1px var(--signal); }

</style></head>
<body>
<header id="header">
  <div class="eyebrow"><span id="dot" class="dot"></span><span id="conn">connecting to TrueForge…</span></div>
  <div class="top"><div class="wordmark">Countersign</div><button id="stop" class="danger big" disabled title="Stop the run (Esc)">■ Stop</button></div>
  <div class="chain" id="chain"></div>
  <div class="actions">
    <button id="undo" class="secondary" disabled>Undo last change</button>
    <button id="session" class="ghost" disabled>Open TrueForge session</button>
  </div>
</header>
<div id="log"><div class="empty"><p class="lead">A coding agent that shows its sources and never writes without you.</p><div class="muted">Ask for a change below, or select code and press Cmd+Alt+K for an inline edit.</div></div></div>
<footer>
  <div id="mentions"></div>
  <textarea id="input" placeholder="Ask for a change. @file or @symbol to pin context. Enter to send, Shift+Enter for a new line."></textarea>
  <div class="send-row"><span class="muted" id="hint">Agent mode: one request, Countersign finds the files.</span><button id="send">Send</button></div>
</footer>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const log = $('log');
let running = false, assistant = null, assistantThread = null, review = null, draftEl = null, chain = [];
const threads = {};
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The transcript follows new output, except for a few seconds after the context card appears,
// so the files it chose (and why) can be read before the run's output pushes them up.
let holdUntil = 0;
function follow() { if (Date.now() >= holdUntil) window.scrollTo(0, document.body.scrollHeight); }
function hold(el, ms) { holdUntil = Date.now() + ms; window.scrollTo(0, el.offsetTop - $('header').offsetHeight - 10); setTimeout(follow, ms + 20); }
function add(el) { log.appendChild(el); follow(); return el; }
function div(cls, html) { const d = document.createElement('div'); d.className = cls; if (html !== undefined) d.innerHTML = html; return d; }
// A card: a head with a title (the part before the first " · ") and its meta, then a body.
function card(kind, label, body, avatar) {
  const at = label.indexOf(' · ');
  const title = at < 0 ? label : label.slice(0, at), meta = at < 0 ? '' : label.slice(at + 3);
  const c = div('card ' + kind);
  c.innerHTML = '<div class="card-head">' + (avatar ? '<span class="avatar">' + esc(avatar) + '</span>' : '') + '<span class="title">' + title + '</span>' + (meta ? '<span class="meta">' + meta + '</span>' : '') + '</div><div class="card-body">' + (body || '') + '</div>';
  return c;
}
// Minimal, escape-first markdown for model text: code fences, inline code, bold, bullets, headings.
function md(src) {
  const parts = String(src).split(/\\n?\\x60\\x60\\x60[\\w-]*\\n?/);
  return parts.map((p, i) => {
    if (i % 2) return '<pre class="draft">' + esc(p) + '</pre>';
    return esc(p)
      .replace(/\\x60([^\\x60\\n]+)\\x60/g, '<code>$1</code>')
      .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>')
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
const ROLES = { 'best code match': 'code', 'best test match': 'test', 'best docs match': 'docs', 'you mentioned it': 'pinned' };
function fileRow(f) {
  const reasons = String(f.why).split('; ');
  const role = reasons.map(r => ROLES[r]).find(Boolean);
  const rest = reasons.filter(r => !ROLES[r]);
  return '<div class="file"><div class="file-row"><span class="path">' + (role ? '<span class="role">' + role + '</span>' : '') + esc(f.path) + '</span><span class="tok">' + f.tokens.toLocaleString() + ' tok</span></div>'
    + (rest.length ? '<div class="why">' + rest.map(esc).join(' · ') + '</div>' : '') + '</div>';
}
function markActive(model) { document.querySelectorAll('#chain .m').forEach(e => e.classList.toggle('active', !!model && (e.textContent === model || model.endsWith(e.textContent) || e.textContent.endsWith(model)))); }

window.addEventListener('message', ev => {
  const m = ev.data;
  switch (m.type) {
    case 'config': {
      chain = m.chain;
      $('dot').className = 'dot' + (m.connected ? ' ok' : '');
      $('header').classList.toggle('offline', !m.connected);
      const connText = m.connected ? 'TrueForge ' + m.url : (m.note || 'TrueForge not reachable at ' + m.url);
      // The last word and the caret stay together so the caret never wraps onto a line of its own.
      $('conn').innerHTML = esc(connText).replace(/(\S+)$/, '<span class="nw">$1' + (m.connected ? '<i class="caret"></i>' : '') + '</span>');
      $('chain').innerHTML = '<span>Models: </span>' + m.chain.map((c, i) => (i ? ' <span class="arrow">→</span> ' : '') + '<span class="m">' + esc(c).split('/').map((x, j, a) => '<span class="nw">' + x + (j < a.length - 1 ? '/' : '') + '</span>').join('<wbr>') + '</span>').join('') + (m.chain.length > 1 ? ' <span>(fallback in order)</span>' : '');
      break;
    }
    case 'running': running = m.running; document.body.classList.toggle('running', running); $('stop').disabled = !running; $('send').disabled = running; if (!running) { finishAssistant(); assistant = null; draftEl = null; } break;
    case 'user': { finishAssistant(); assistant = null; const who = m.mode === 'inline' ? 'Inline edit' : 'You'; add(card('user', who, '<div class="msg">' + esc(m.text) + '</div>', m.mode === 'inline' ? '⌘' : 'Y')); break; }
    case 'status': add(div('status ' + m.kind, esc(m.text))); finishAssistant(); assistant = null; break;
    case 'session': $('session').disabled = false; markActive(m.model); add(div('status info', 'TrueForge session started on <b>' + esc(m.model) + '</b> · <a data-act="session">open session</a>')); break;
    case 'context': {
      const pct = Math.min(100, Math.round(100 * m.used / m.budget));
      const label = m.by === 'auto'
        ? 'Context chosen automatically · ' + m.files.length + ' files'
        : 'Agent asked for more context · ' + m.files.length + ' file' + (m.files.length === 1 ? '' : 's');
      const body = '<div class="budget-row"><span><b>' + m.used.toLocaleString() + '</b> of ' + m.budget.toLocaleString() + ' tokens</span><span>searched ' + m.indexed + ' files</span></div>'
        + '<div class="budget"><div style="width:' + pct + '%"></div></div>'
        + (m.by === 'auto' ? m.files.map(fileRow).join('') : '<div class="file"><span class="path">' + m.files.map(f => esc(f.path)).join(', ') + '</span></div>')
        + (m.omitted ? '<div class="left-out muted">Left out: ' + m.omitted + ' files (' + m.omittedSample.map(esc).join(', ') + (m.omitted > m.omittedSample.length ? ', …' : '') + ')</div>' : '');
      const ctxCard = add(card('context', label, body));
      if (m.by === 'auto') hold(ctxCard, 6000);
      finishAssistant(); assistant = null; break;
    }
    case 'thread': {
      if (m.done) { const t = threads[m.thread]; if (t) t.meta.textContent = m.status || 'done'; break; }
      const c = add(card('thread', '↳ subagent ' + esc(m.title) + ' · running'));
      const b = c.querySelector('.card-body');
      if (m.instructions) b.appendChild(div('muted', esc(m.instructions.slice(0, 280)) + (m.instructions.length > 280 ? '…' : '')));
      const body = div(''); b.appendChild(body);
      threads[m.thread] = { meta: c.querySelector('.meta'), body, title: m.title };
      finishAssistant(); assistant = null; break;
    }
    case 'delta': {
      if (!assistant || assistantThread !== m.thread) { finishAssistant(); const c = div('reply'); c.dataset.raw = ''; container(m.thread).appendChild(c); assistant = c; assistantThread = m.thread; }
      assistant.dataset.raw += m.text; assistant.textContent = assistant.dataset.raw; follow(); break;
    }
    case 'draft': {
      const t = partialNewText(m.preview);
      if (t == null) break;
      if (!draftEl) { const c = card('drafting', 'Drafting ' + esc(m.name) + '…'); draftEl = div('draft'); c.querySelector('.card-body').appendChild(draftEl); container(m.thread).appendChild(c); }
      draftEl.textContent = t; draftEl.scrollTop = draftEl.scrollHeight; follow(); break;
    }
    case 'tool': {
      draftEl = null;
      const d = div('tool', '<span class="tname">⚙ ' + esc(m.name) + '</span> ' + esc(m.detail) + (m.result ? ' <span class="res">→ ' + esc(m.result) + '</span>' : ''));
      container(m.thread).appendChild(d); finishAssistant(); assistant = null; follow(); break;
    }
    case 'review': renderReview(m.snapshot); break;
    case 'git': add(div('status git ' + (m.clean ? 'ok' : 'info'), esc(m.text))); break;
    case 'changes': { const live = m.items.filter(i => !i.undone); $('undo').disabled = !live.length; $('undo').title = live.length ? 'Undo: ' + live[live.length - 1].label : ''; break; }
    case 'mentions': showMentions(m.items); break;
    case 'approveCommand': {
      const c = add(card('cmd', 'Run this command? · TrueForge is waiting on this approval.',
        '<pre class="draft">$ ' + esc(m.command) + '</pre>'
        + (m.explanation ? '<div class="why">' + esc(m.explanation) + '</div>' : '')
        + '<div class="lead-actions"><button class="big" data-act="cmd" data-id="' + esc(m.id) + '" data-allow="1">Allow</button><button class="secondary big" data-act="cmd" data-id="' + esc(m.id) + '" data-allow="0">Deny</button></div>'));
      c.id = 'cmd-' + m.id;
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
  if (!s) { if (review) { review.querySelectorAll('button').forEach(b => b.disabled = true); review.classList.add('closed'); review.querySelector('.title').textContent = 'Review closed'; const mt = review.querySelector('.meta'); if (mt) mt.textContent = ''; } review = null; return; }
  if (!review) { review = add(div('card review')); }
  const total = s.files.reduce((a, f) => a + f.hunks.length, 0);
  const pending = s.files.reduce((a, f) => a + f.hunks.filter(h => h.state === 'pending').length, 0);
  let h = '<div class="card-head"><span class="title">Review</span><span class="meta">' + s.files.length + ' file' + (s.files.length > 1 ? 's' : '') + ' · ' + pending + ' of ' + total + ' hunks pending</span></div><div class="card-body">'
    + '<div class="lead-actions"><button class="big" data-act="all" data-d="accepted">✓ Accept all</button><button class="secondary big" data-act="all" data-d="rejected">✗ Reject all</button></div>'
    + '<div class="notice">Nothing is written until you decide. TrueForge is waiting on this approval.</div>';
  for (const f of s.files) {
    h += '<div class="rfile"><div class="file-row"><span class="path"><b>' + esc(f.path) + '</b></span>' + (f.isNew ? '<span class="muted">(new file)</span>' : '') + '<a class="muted" data-act="diff" data-key="' + esc(f.key) + '">open diff</a></div>';
    if (f.explanation) h += '<div class="why">' + esc(f.explanation) + '</div>';
    for (const k of f.hunks) {
      h += '<div class="hunk ' + k.state + '"><div class="hunk-head"><span>Hunk ' + k.n + ' · ' + esc(k.summary) + '</span><span class="acts">'
        + (k.state === 'pending'
          ? '<button data-act="hunk" data-key="' + esc(f.key) + '" data-id="' + esc(k.id) + '" data-d="accepted">✓ Accept</button><button class="secondary" data-act="hunk" data-key="' + esc(f.key) + '" data-id="' + esc(k.id) + '" data-d="rejected">✗ Reject</button>'
          : '<span class="decided">' + (k.state === 'accepted' ? '✓ accepted' : '✗ rejected') + '</span><a class="muted" data-act="hunk" data-key="' + esc(f.key) + '" data-id="' + esc(k.id) + '" data-d="pending">change</a>')
        + '</span></div><pre class="diff">' + k.lines.map(l => '<span class="' + (l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '') + '">' + esc(l) + '</span>').join('') + '</pre></div>';
    }
    h += '</div>';
  }
  review.innerHTML = h + '</div>';
  // Keep the review's heading and Accept all in view, just under the sticky header.
  window.scrollTo(0, review.offsetTop - $('header').offsetHeight - 10);
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
