import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Scripted demo driver, enabled only when COUNTERSIGN_DRIVER_DIR is set (never in normal use).
 * It plays real UI steps (open files, select code, type an instruction into the real input box,
 * click review buttons) from a JSONL file, so recordings and visual checks are reproducible.
 */
export type DriverStep =
  | { do: 'open'; path: string; line?: number }
  | { do: 'select'; path: string; symbol: string }
  | { do: 'inline'; text: string; cps?: number }
  | { do: 'agent'; text: string; cps?: number }
  | { do: 'command'; id: string; args?: unknown[] }
  | { do: 'wait'; ms: number }
  | { do: 'waitFor'; what: 'review' | 'idle' | 'running'; timeoutMs?: number }
  | { do: 'terminal'; text: string; name?: string }
  | { do: 'focusPanel' }
  | { do: 'allowCommand'; allow?: boolean; timeoutMs?: number }
  | { do: 'finish'; timeoutMs?: number }
  | { do: 'hunk'; file?: number; n: number; decision: 'accepted' | 'rejected' };

export interface DriverHooks {
  typeInline(text: string, cps: number): Promise<void>;
  typeAgent(text: string, cps: number): Promise<void>;
  state(): { running: boolean; review: unknown };
  decide(file: number, n: number, decision: 'accepted' | 'rejected'): void;
  answerCommand(allow: boolean): void;
  hasPendingCommand(): boolean;
}

export function startDriver(ctx: vscode.ExtensionContext, hooks: DriverHooks) {
  // VS Code does not always pass the launching shell's environment to the extension host, so a
  // user setting (set only in a recording profile) works too.
  const dir = process.env.COUNTERSIGN_DRIVER_DIR || vscode.workspace.getConfiguration('countersign').get<string>('driverDir');
  if (!dir) return;
  const inbox = path.join(dir, 'steps.jsonl');
  let offset = 0;
  let busy = false;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const term = new Map<string, vscode.Terminal>();

  async function runStep(s: DriverStep) {
    switch (s.do) {
      case 'open': {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root!, s.path));
        const ed = await vscode.window.showTextDocument(doc, { preview: false });
        if (s.line) ed.revealRange(new vscode.Range(s.line - 1, 0, s.line - 1, 0), vscode.TextEditorRevealType.AtTop);
        return;
      }
      case 'select': {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root!, s.path));
        const ed = await vscode.window.showTextDocument(doc, { preview: false });
        const lines = doc.getText().split('\n');
        const start = lines.findIndex(l => new RegExp(`^\\s*(async\\s+)?(def|class)\\s+${s.symbol}\\b`).test(l));
        if (start < 0) throw new Error(`symbol ${s.symbol} not found`);
        const indent = /^\s*/.exec(lines[start])![0].length;
        let end = start + 1;
        while (end < lines.length && (lines[end].trim() === '' || /^\s*/.exec(lines[end])![0].length > indent)) end++;
        while (!lines[end - 1].trim()) end--;
        // Select line by line, the way a person drags, so the selection is visible on screen.
        for (let l = start; l <= end; l += 2) {
          ed.selection = new vscode.Selection(start, 0, Math.min(l, end), 0);
          ed.revealRange(new vscode.Range(start, 0, Math.min(l, end), 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          await sleep(40);
        }
        ed.selection = new vscode.Selection(start, 0, end, 0);
        return;
      }
      case 'inline':
        return hooks.typeInline(s.text, s.cps ?? 45);
      case 'agent':
        return hooks.typeAgent(s.text, s.cps ?? 45);
      case 'command':
        await vscode.commands.executeCommand(s.id, ...(s.args ?? []));
        return;
      case 'wait':
        await sleep(s.ms);
        return;
      case 'waitFor': {
        const t0 = Date.now();
        for (;;) {
          const st = hooks.state();
          if (s.what === 'review' && st.review) return;
          if (s.what === 'idle' && !st.running) return;
          if (s.what === 'running' && st.running) return;
          if (Date.now() - t0 > (s.timeoutMs ?? 300_000)) throw new Error(`driver: timed out waiting for ${s.what}`);
          await sleep(150);
        }
      }
      case 'terminal': {
        const name = s.name ?? 'verify';
        let t = term.get(name);
        if (!t || t.exitStatus) {
          t = vscode.window.createTerminal({ name, cwd: root });
          term.set(name, t);
        }
        t.show(false);
        t.sendText(s.text, true);
        return;
      }
      case 'hunk':
        hooks.decide(s.file ?? 0, s.n, s.decision);
        return;
      case 'allowCommand': {
        const t0 = Date.now();
        while (!hooks.hasPendingCommand()) {
          if (Date.now() - t0 > (s.timeoutMs ?? 300_000)) throw new Error('driver: no command to approve');
          await sleep(150);
        }
        await sleep(900);
        hooks.answerCommand(s.allow ?? true);
        return;
      }
      case 'finish': {
        // Plays the user through the rest of a run: allows each command and accepts each later review.
        const t0 = Date.now();
        while (hooks.state().running) {
          if (Date.now() - t0 > (s.timeoutMs ?? 600_000)) throw new Error('driver: run did not finish');
          if (hooks.hasPendingCommand()) {
            await sleep(900);
            hooks.answerCommand(true);
          } else if (hooks.state().review) {
            await sleep(1800);
            await vscode.commands.executeCommand('countersign.acceptAll');
          }
          await sleep(250);
        }
        return;
      }
      case 'focusPanel':
        await vscode.commands.executeCommand('countersign.agent.focus');
        return;
    }
  }

  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const text = await fs.readFile(inbox, 'utf8').catch(() => '');
      if (text.length < offset) offset = 0;
      const fresh = text.slice(offset);
      const lines = fresh.split('\n');
      const complete = lines.slice(0, -1);
      offset += complete.reduce((a, l) => a + l.length + 1, 0);
      for (const line of complete) {
        if (!line.trim()) continue;
        const step = JSON.parse(line) as DriverStep;
        await fs.appendFile(path.join(dir, 'log.txt'), `${new Date().toISOString()} start ${line}\n`);
        try {
          await runStep(step);
          await fs.appendFile(path.join(dir, 'log.txt'), `${new Date().toISOString()} done\n`);
        } catch (e) {
          await fs.appendFile(path.join(dir, 'log.txt'), `${new Date().toISOString()} error ${(e as Error).message}\n`);
        }
      }
    } finally {
      busy = false;
    }
  }, 250);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}
