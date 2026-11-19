import * as vscode from 'vscode';
import { applyHunks, summarizeHunk, type Hunk } from '../core/edits';
import type { PendingProposal } from '../core/proposals';

export const PROPOSED_SCHEME = 'countersign-proposed';

type HunkState = 'pending' | 'accepted' | 'rejected';

interface ReviewFile {
  key: string;
  proposal: PendingProposal;
  state: Map<string, HunkState>;
  uri: vscode.Uri;
}

export interface ReviewSnapshot {
  files: {
    key: string;
    path: string;
    explanation: string;
    isNew: boolean;
    hunks: { id: string; n: number; state: HunkState; summary: string; lines: string[]; oldStart: number }[];
  }[];
}

/**
 * Per-hunk review in the real diff editor. The left side is the file as it is now; the right side
 * is a virtual document showing the proposal with rejected hunks removed. CodeLens above each hunk
 * accepts or rejects it, and the panel mirrors the same state. Nothing is written here: the
 * decisions go back to TrueForge as the tool approval, and the approved MCP call writes them.
 */
export class ReviewManager implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private files = new Map<string, ReviewFile>();
  private seq = 0;
  private resolveAll?: () => void;
  private rejectAll?: (e: Error) => void;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  readonly onDidChangeCodeLenses = this.lensChanged.event;
  readonly onState = new vscode.EventEmitter<ReviewSnapshot | null>();
  private accepted = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'), isWholeLine: true, overviewRulerColor: 'rgba(80,200,120,0.8)', after: { contentText: '  ✓ accepted', color: new vscode.ThemeColor('testing.iconPassed') } });

  constructor(private readonly root: vscode.Uri) {}

  register(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, this),
      vscode.commands.registerCommand('countersign.hunk', (key: string, hunkId: string, decision: HunkState) => this.decide(key, hunkId, decision)),
      vscode.commands.registerCommand('countersign.fileAll', (key: string, decision: HunkState) => this.decideFile(key, decision)),
      vscode.commands.registerCommand('countersign.acceptAll', () => this.decideEverything('accepted')),
      vscode.commands.registerCommand('countersign.rejectAll', () => this.decideEverything('rejected')),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
    );
  }

  get active() {
    return this.files.size > 0;
  }

  /** Opens the review for a batch of proposals and resolves with the accepted hunk ids per proposal. */
  async review(proposals: PendingProposal[], signal: AbortSignal): Promise<Set<string>[]> {
    if (this.files.size) this.cancel();
    const keys: string[] = [];
    for (const p of proposals) {
      const key = `r${++this.seq}`;
      const uri = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: '/' + p.file.path, query: key });
      this.files.set(key, { key, proposal: p, state: new Map(p.file.hunks.map(h => [h.id, 'pending' as HunkState])), uri });
      keys.push(key);
    }
    this.emit();
    const first = this.files.get(keys[0]);
    if (first) await this.open(first);
    await new Promise<void>((resolve, reject) => {
      this.resolveAll = resolve;
      this.rejectAll = reject;
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }).finally(() => {
      this.resolveAll = undefined;
      this.rejectAll = undefined;
    });
    const out = keys.map(k => {
      const f = this.files.get(k)!;
      return new Set([...f.state].filter(([, s]) => s === 'accepted').map(([id]) => id));
    });
    await this.close();
    return out;
  }

  /** Drops every open review; used by Stop. Nothing has been written, so nothing needs reverting. */
  cancel() {
    this.rejectAll?.(new Error('cancelled'));
    void this.close();
  }

  private async close() {
    const uris = [...this.files.values()].map(f => f.uri.toString());
    this.files.clear();
    this.emit();
    for (const tab of vscode.window.tabGroups.all.flatMap(g => g.tabs)) {
      const input = tab.input as { modified?: vscode.Uri } | undefined;
      if (input?.modified && uris.includes(input.modified.toString())) await vscode.window.tabGroups.close(tab, true);
    }
  }

  async open(f: ReviewFile) {
    const left = f.proposal.file.original == null ? vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: '/' + f.proposal.file.path, query: `${f.key}-empty` }) : vscode.Uri.joinPath(this.root, f.proposal.file.path);
    const n = f.proposal.file.hunks.length;
    await vscode.commands.executeCommand('vscode.diff', left, f.uri, `Review: ${f.proposal.file.path} (${n} hunk${n === 1 ? '' : 's'})`, { preview: false, preserveFocus: false });
    setTimeout(() => this.decorate(), 150);
  }

  async openByKey(key: string) {
    const f = this.files.get(key);
    if (f) await this.open(f);
  }

  /** The proposal as it would land now: rejected hunks removed. */
  private preview(f: ReviewFile): string {
    const keep = new Set([...f.state].filter(([, s]) => s !== 'rejected').map(([id]) => id));
    if (keep.size === f.proposal.file.hunks.length) return f.proposal.file.proposed;
    return applyHunks(f.proposal.file.original ?? '', f.proposal.file.hunks, keep);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.query.endsWith('-empty')) return '';
    const f = this.files.get(uri.query);
    return f ? this.preview(f) : '';
  }

  /** Where each visible hunk starts in the preview document (0-based line). */
  private hunkLines(f: ReviewFile): { h: Hunk; line: number }[] {
    const out: { h: Hunk; line: number }[] = [];
    let shift = 0;
    const sorted = [...f.proposal.file.hunks].sort((a, b) => a.oldStart - b.oldStart);
    for (const h of sorted) {
      const st = f.state.get(h.id)!;
      const firstChange = h.lines.findIndex(l => l[0] !== ' ');
      const base = (h.oldLines === 0 ? h.oldStart : h.oldStart - 1) + shift;
      if (st !== 'rejected') {
        const ctxBefore = h.lines.slice(0, Math.max(firstChange, 0)).length;
        out.push({ h, line: Math.max(0, base + ctxBefore) });
        shift += h.newLines - h.oldLines;
      } else {
        out.push({ h, line: Math.max(0, base) });
      }
    }
    return out;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const f = this.files.get(doc.uri.query);
    if (!f) return [];
    const lenses: vscode.CodeLens[] = [];
    const total = f.proposal.file.hunks.length;
    const top = new vscode.Range(0, 0, 0, 0);
    const pending = [...f.state.values()].filter(s => s === 'pending').length;
    lenses.push(new vscode.CodeLens(top, { title: `Countersign: ${pending} of ${total} hunk${total === 1 ? '' : 's'} to review`, command: '' }));
    if (pending) {
      lenses.push(new vscode.CodeLens(top, { title: '✓ Accept all in file', command: 'countersign.fileAll', arguments: [f.key, 'accepted'] }));
      lenses.push(new vscode.CodeLens(top, { title: '✗ Reject all in file', command: 'countersign.fileAll', arguments: [f.key, 'rejected'] }));
    }
    for (const { h, line } of this.hunkLines(f)) {
      const st = f.state.get(h.id)!;
      const n = h.id.split('#')[1];
      const r = new vscode.Range(line, 0, line, 0);
      if (st === 'pending') {
        lenses.push(new vscode.CodeLens(r, { title: `✓ Accept hunk ${n}`, command: 'countersign.hunk', arguments: [f.key, h.id, 'accepted'] }));
        lenses.push(new vscode.CodeLens(r, { title: `✗ Reject hunk ${n}`, command: 'countersign.hunk', arguments: [f.key, h.id, 'rejected'] }));
        lenses.push(new vscode.CodeLens(r, { title: summarizeHunk(h), command: '' }));
      } else {
        lenses.push(new vscode.CodeLens(r, { title: `${st === 'accepted' ? '✓ accepted' : '✗ rejected'} hunk ${n} · undo`, command: 'countersign.hunk', arguments: [f.key, h.id, 'pending'] }));
      }
    }
    return lenses;
  }

  private decorate() {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== PROPOSED_SCHEME) continue;
      const f = this.files.get(ed.document.uri.query);
      if (!f) continue;
      const ranges: vscode.Range[] = [];
      for (const { h, line } of this.hunkLines(f)) {
        if (f.state.get(h.id) !== 'accepted') continue;
        const added = h.lines.filter(l => l[0] === '+').length;
        if (added) ranges.push(new vscode.Range(line, 0, line + added - 1, 0));
      }
      ed.setDecorations(this.accepted, ranges);
    }
  }

  decide(key: string, hunkId: string, decision: HunkState) {
    const f = this.files.get(key);
    if (!f || !f.state.has(hunkId)) return;
    f.state.set(hunkId, decision);
    this.refresh(f);
  }

  decideFile(key: string, decision: HunkState) {
    const f = this.files.get(key);
    if (!f) return;
    for (const id of f.state.keys()) if (f.state.get(id) === 'pending') f.state.set(id, decision);
    this.refresh(f);
  }

  decideEverything(decision: HunkState) {
    for (const f of this.files.values()) for (const id of f.state.keys()) if (f.state.get(id) === 'pending') f.state.set(id, decision);
    for (const f of this.files.values()) this.refresh(f, false);
    this.checkDone();
  }

  private refresh(f: ReviewFile, check = true) {
    this.changed.fire(f.uri);
    this.lensChanged.fire();
    setTimeout(() => this.decorate(), 60);
    this.emit();
    if (check) this.checkDone();
  }

  private checkDone() {
    const all = [...this.files.values()];
    const filePending = (x: ReviewFile) => [...x.state.values()].some(s => s === 'pending');
    if (all.length && all.every(x => !filePending(x))) {
      // Short pause so the last ✓ is visible before the diff closes.
      setTimeout(() => this.resolveAll?.(), 450);
      return;
    }
    // Move on to the next file that still needs a decision.
    const next = all.find(filePending);
    const visible = vscode.window.visibleTextEditors.some(e => e.document.uri.toString() === next?.uri.toString());
    if (next && !visible) void this.open(next);
  }

  snapshot(): ReviewSnapshot | null {
    if (!this.files.size) return null;
    return {
      files: [...this.files.values()].map(f => ({
        key: f.key,
        path: f.proposal.file.path,
        explanation: f.proposal.explanation,
        isNew: f.proposal.file.original == null,
        hunks: f.proposal.file.hunks.map((h, i) => ({ id: h.id, n: i + 1, state: f.state.get(h.id)!, summary: summarizeHunk(h), lines: h.lines.slice(0, 40), oldStart: h.oldStart })),
      })),
    };
  }

  private emit() {
    this.onState.fire(this.snapshot());
  }
}
