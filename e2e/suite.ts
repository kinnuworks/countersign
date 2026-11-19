/**
 * Runs inside a real VS Code with Countersign loaded, against a real local TrueForge and real
 * models, on a fresh pallets/flask 3.1.3. It plays the user: selects code, gives the instruction,
 * accepts hunks in the review, then checks the result the way the video does.
 */
import * as vscode from 'vscode';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

type State = { running: boolean; connected: boolean; review: { files: { path: string; hunks: unknown[] }[] } | null; last?: { status: string; model?: string; attempts: unknown[] }; statuses: string[]; journal: { id: string; undone: boolean }[] };
const st = async () => (await vscode.commands.executeCommand('countersign.state')) as State;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (s: string) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${s}`);

async function waitFor(label: string, pred: (s: State) => boolean, ms: number): Promise<State> {
  const t0 = Date.now();
  for (;;) {
    const s = await st();
    if (pred(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${label}; statuses: ${s.statuses.slice(-5).join(' | ')}`);
    await sleep(200);
  }
}

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const sh = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}/.venv/bin:${process.env.PATH}` } }).trim();
  const results: Record<string, unknown> = {};
  const chainNote = process.env.E2E_CHAIN ?? 'default';
  await vscode.workspace.getConfiguration('countersign').update('models', process.env.E2E_CHAIN ? process.env.E2E_CHAIN.split(',') : [], vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('countersign.reconnect');
  await waitFor('connected to TrueForge', s => s.connected, 60_000);
  log(`connected (chain ${chainNote})`);

  // Task A: select get_debug_flag, give the instruction, review, accept.
  const uri = vscode.Uri.file(`${root}/src/flask/helpers.py`);
  const doc = await vscode.workspace.openTextDocument(uri);
  const ed = await vscode.window.showTextDocument(doc);
  const lines = doc.getText().split('\n');
  const start = lines.findIndex(l => l.startsWith('def get_debug_flag'));
  let end = start + 1;
  while (end < lines.length && !/^(def|class|@)/.test(lines[end])) end++;
  while (!lines[end - 1].trim()) end--;
  ed.selection = new vscode.Selection(start, 0, end, 0);
  const t0 = Date.now();
  void vscode.commands.executeCommand('countersign.inlineEditWith', TASK_A);
  const reviewState = await waitFor('Task A review to open', s => !!s.review, 240_000);
  results.taskA_reviewAfterMs = Date.now() - t0;
  results.taskA_hunks = reviewState.review!.files.map(f => `${f.path}: ${f.hunks.length}`);
  results.taskA_diffEditorShown = vscode.window.visibleTextEditors.some(e => e.document.uri.scheme === 'countersign-proposed');
  results.taskA_gitBeforeAccept = sh('git status --porcelain') || 'clean';
  if (results.taskA_gitBeforeAccept !== 'clean') throw new Error('a write happened before the review was accepted');
  log(`review open after ${results.taskA_reviewAfterMs} ms: ${results.taskA_hunks}`);
  await vscode.commands.executeCommand('countersign.acceptAll');
  const doneA = await waitFor('Task A run to finish', s => !s.running, 240_000);
  results.taskA_status = doneA.last?.status;
  results.taskA_model = doneA.last?.model;
  results.taskA_verify = sh(`FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`);
  results.taskA_verify_N = sh(`FLASK_DEBUG=N python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`);
  results.taskA_verify_1 = sh(`FLASK_DEBUG=1 python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`);
  results.taskA_diff = sh('git diff --stat');
  log(`Task A: ${results.taskA_status} on ${results.taskA_model}; FLASK_DEBUG=off -> ${results.taskA_verify}`);
  if (results.taskA_verify !== 'False' || results.taskA_verify_N !== 'False' || results.taskA_verify_1 !== 'True') throw new Error(`Task A verification failed: ${JSON.stringify(results)}`);

  if (process.env.E2E_ONLY_A) {
    results.taskA_attempts = doneA.last?.attempts;
    results.taskA_statuses = doneA.statuses.slice(-6);
    await vscode.commands.executeCommand('countersign.undo');
    if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT, JSON.stringify(results, null, 2));
    log(`attempts: ${JSON.stringify(doneA.last?.attempts)}`);
    log('all passed');
    return;
  }

  // Undo the applied change.
  await vscode.commands.executeCommand('countersign.undo');
  await sleep(500);
  results.undo_git = sh('git status --porcelain') || 'clean';
  log(`after undo: ${results.undo_git}`);
  if (results.undo_git !== 'clean') throw new Error('undo did not restore the file');

  // Cancel mid-flight in agent mode.
  void vscode.commands.executeCommand('countersign.agentRequest', TASK_B);
  await waitFor('agent run to start', s => s.running, 30_000);
  await sleep(Number(process.env.E2E_CANCEL_AFTER_MS ?? 7000));
  const tc = Date.now();
  await vscode.commands.executeCommand('countersign.cancel');
  const doneC = await waitFor('cancel to finish', s => !s.running, 20_000);
  results.cancel_latencyMs = Date.now() - tc;
  results.cancel_status = doneC.last?.status;
  results.cancel_git = sh('git status --porcelain') || 'clean';
  log(`cancel: ${results.cancel_status} in ${results.cancel_latencyMs} ms; git: ${results.cancel_git}`);
  if (results.cancel_status !== 'cancelled' || results.cancel_git !== 'clean') throw new Error(`cancel check failed: ${JSON.stringify(results)}`);

  if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT, JSON.stringify(results, null, 2));
  log('all passed');
}
