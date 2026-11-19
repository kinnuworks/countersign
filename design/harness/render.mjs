// Renders the agent panel outside VS Code for design work: the real html() from the built
// extension bundle, VS Code's Dark Modern / Light Modern theme variables, and scripted panel
// messages for each state. Usage: node design/harness/render.mjs [outdir]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
const require = createRequire(import.meta.url);
const out = process.argv[2] ?? 'design/harness/out';
mkdirSync(out, { recursive: true });

// Pull html() out of the bundled panel source.
const src = readFileSync('src/extension/panel.ts', 'utf8');
const start = src.indexOf('return /* html */ `') + 'return /* html */ '.length;
const end = src.indexOf('</html>`', start) + '</html>`'.length;
const fontsSrc = readFileSync('src/extension/panelFonts.ts', 'utf8');
const FONT_CSS = JSON.parse(fontsSrc.slice(fontsSrc.indexOf('= ') + 2, fontsSrc.lastIndexOf(';')));
const panelHtml = new Function('n', 'FONT_CSS', 'return ' + src.slice(start, end))('h', FONT_CSS);

const common = { 'font-family': '-apple-system, BlinkMacSystemFont, sans-serif', 'font-size': '13px', 'editor-font-family': "Menlo, Monaco, 'Courier New', monospace", 'editor-font-size': '12px' };
const dark = { 'sideBar-background': '#181818', 'editor-background': '#1f1f1f', 'editorWidget-background': '#202020', foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'panel-border': '#2b2b2b', 'input-border': '#3c3c3c', 'input-background': '#313131', 'input-foreground': '#cccccc', 'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'inputValidation-errorBackground': '#5a1d1d', 'testing-iconPassed': '#73c991', 'textLink-foreground': '#4daafc', 'editorWarning-foreground': '#cca700', errorForeground: '#f85149', 'badge-background': '#616161', 'badge-foreground': '#f8f8f8', 'focusBorder': '#0078d4', 'textCodeBlock-background': '#2b2b2b', 'diffEditor-insertedLineBackground': 'rgba(155,185,85,0.2)', 'diffEditor-removedLineBackground': 'rgba(255,0,0,0.2)', 'editorSuggestWidget-background': '#202020', 'editorSuggestWidget-border': '#454545', 'editorSuggestWidget-selectedBackground': '#04395e' };
const light = { 'sideBar-background': '#f8f8f8', 'editor-background': '#ffffff', 'editorWidget-background': '#f8f8f8', foreground: '#3b3b3b', descriptionForeground: '#3b3b3b', 'panel-border': '#e5e5e5', 'input-border': '#cecece', 'input-background': '#ffffff', 'input-foreground': '#3b3b3b', 'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-secondaryBackground': '#e5e5e5', 'button-secondaryForeground': '#3b3b3b', 'inputValidation-errorBackground': '#f2dede', 'testing-iconPassed': '#388a34', 'textLink-foreground': '#005fb8', 'editorWarning-foreground': '#bf8803', errorForeground: '#f85149', 'badge-background': '#cccccc', 'badge-foreground': '#3b3b3b', 'focusBorder': '#005fb8', 'textCodeBlock-background': '#f0f0f0', 'diffEditor-insertedLineBackground': 'rgba(155,185,85,0.2)', 'diffEditor-removedLineBackground': 'rgba(255,0,0,0.2)', 'editorSuggestWidget-background': '#f8f8f8', 'editorSuggestWidget-border': '#c8c8c8', 'editorSuggestWidget-selectedBackground': '#e8e8e8' };
const vars = t => Object.entries({ ...common, ...t }).map(([k, v]) => `--vscode-${k}: ${v};`).join(' ');

const ctx = JSON.parse(readFileSync('design/harness/ctx.json', 'utf8'));
const chain = ['anthropic/claude-sonnet-5-5', 'anthropic-openai/claude-haiku-5-5'];
const cfg = (c = chain) => ({ type: 'config', chain: c, connected: true, url: 'http://localhost:8790' });
const taskAFile = 'src/flask/helpers.py';
const hunks = [
  { id: 'h#1', n: 1, state: 'accepted', summary: 'lines 29-31: +5 -3', oldStart: 29, lines: [' def get_debug_flag() -> bool:', '-    """Get whether debug mode should be enabled for the app, indicated by the', '-    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.', '-    """', '+    """Get whether debug mode should be enabled for the app, indicated by the', '+    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.', '+', '+    The values ``0``, ``false``, ``no``, ``off`` and ``n`` (in any case)', '+    are treated as false.', '+    """', '     val = os.environ.get("FLASK_DEBUG")'] },
  { id: 'h#2', n: 2, state: 'pending', summary: 'line 33: +1 -1', oldStart: 33, lines: ['     val = os.environ.get("FLASK_DEBUG")', '-    return bool(val and val.lower() not in {"0", "false", "no"})', '+    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})', ' '] },
];
const snap = st => ({ type: 'review', snapshot: { files: [{ key: 'r1', path: taskAFile, explanation: 'Adds "off" and "n" to the false values and lists every false value in the docstring.', isNew: false, hunks: hunks.map((h, i) => ({ ...h, state: st?.[i] ?? h.state })) }] } });
const sm = { ...ctx.context, files: ctx.context.files.slice(0, 1).map(f => ({ ...f, path: taskAFile, why: 'you mentioned it', tokens: 412 })), used: 412, omitted: 0, omittedSample: [] };

const states = {
  empty: [cfg()],
  run: [cfg(), { type: 'user', mode: 'agent', text: ctx.taskB }, { type: 'running', running: true }, { type: 'session', url: 'http://localhost:8790/sessions/1', model: chain[0] }, ctx.context,
    { type: 'thread', thread: 't1', title: 'context-scout', instructions: 'Find where the built-in commands (routes, shell, run) are registered and how tests invoke them.' },
    { type: 'tool', thread: 't1', name: 'search_code', detail: '"routes_command"', result: '3 matches in 2 files' },
    { type: 'tool', thread: 't1', name: 'read_file', detail: 'src/flask/cli.py:1030-1080', result: '51 lines' },
    { type: 'thread', thread: 't1', done: true, status: 'done' },
    { type: 'delta', thread: 'main', text: 'Files I will change: src/flask/cli.py (new config command next to routes), tests/test_cli.py (masking test), docs/cli.rst (built-in commands list).' },
    { type: 'tool', thread: 'main', name: 'read_file', detail: 'src/flask/cli.py:960-1010', result: '51 lines' },
    { type: 'approveCommand', id: 'c1', command: 'python -m pytest tests/test_cli.py -q', explanation: 'Run the CLI tests after the edit.' }],
  review: [cfg(), { type: 'user', mode: 'inline', text: `${taskAFile}:28-33 · ${ctx.taskA}` }, { type: 'running', running: true }, { type: 'session', url: 'x', model: chain[0] }, sm, snap()],
  fallback: [cfg(['broken/claude-sonnet-5-5', ...chain]), { type: 'user', mode: 'inline', text: `${taskAFile}:28-33 · ${ctx.taskA}` }, { type: 'running', running: true },
    { type: 'status', kind: 'warn', text: 'broken/claude-sonnet-5-5: network error (connect ECONNREFUSED 127.0.0.1:9). Retry 1/2 in 0.8s.' },
    { type: 'status', kind: 'warn', text: 'broken/claude-sonnet-5-5: network error (connect ECONNREFUSED 127.0.0.1:9). Retry 2/2 in 1.6s.' },
    { type: 'status', kind: 'warn', text: 'broken/claude-sonnet-5-5 unavailable (network: connect ECONNREFUSED 127.0.0.1:9). Switching to fallback model anthropic/claude-sonnet-5-5.' },
    { type: 'session', url: 'x', model: chain[0] }, snap(['accepted', 'accepted']), { type: 'review', snapshot: null },
    { type: 'status', kind: 'ok', text: `Approved 2/2 hunks of ${taskAFile}; TrueForge runs the write.` }, { type: 'running', running: false },
    { type: 'changes', items: [{ id: 'c1', label: 'Inline edit', undone: false }] },
    { type: 'git', clean: false, text: 'git status --porcelain:\n M src/flask/helpers.py' }],
  cancel: [cfg(), { type: 'user', mode: 'agent', text: ctx.taskB }, { type: 'running', running: true }, { type: 'session', url: 'x', model: chain[0] }, ctx.context,
    { type: 'delta', thread: 'main', text: 'I will add the command to src/flask/cli.py next to `routes_command`, then' },
    { type: 'status', kind: 'warn', text: 'Stopped by you. Cancelling the TrueForge turn…' }, { type: 'running', running: false },
    { type: 'status', kind: 'warn', text: 'Cancelled. The model stopped, open reviews were dropped, and no half-applied edits exist (writes only happen inside an approved, complete tool call).' },
    { type: 'git', clean: true, text: 'git status: clean, no files changed' }],
  offline: [{ type: 'config', chain, connected: false, url: 'http://localhost:8790', note: `TrueForge is not running at http://localhost:8790. Start it with: OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest` }],
};

const page = (dir, theme, msgs) => panelHtml
  .replace('<html>', `<html style="${vars(theme === 'dark' ? dark : light)}">`)
  .replace('<body>', `<body class="vscode-${theme}" data-vscode-theme-kind="vscode-${theme}">`)
  .replace('<script nonce="h">', `<script nonce="h">window.acquireVsCodeApi = () => ({ postMessage() {}, setState() {}, getState() {} });</script><script nonce="h">`)
  .replace('</body>', `<script nonce="h">for (const m of ${JSON.stringify(msgs)}) window.dispatchEvent(new MessageEvent('message', { data: m }));</script></body>`);

const files = [];
for (const dir of ['a']) for (const theme of ['dark', 'light']) for (const [st, msgs] of Object.entries(states)) {
  const f = `${out}/${dir}-${theme}-${st}.html`;
  writeFileSync(f, page(dir, theme, msgs));
  files.push(f);
}
console.log('wrote', files.length, 'pages');
