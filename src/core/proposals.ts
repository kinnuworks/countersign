import { applyHunks, applySearchReplace, buildProposal, normalizeEdits, summarizeHunk, type FileProposal } from './edits';
import type { ToolCallInfo } from './forge';
import { ApprovalBook, type Decision } from './tools';
import { safeRel, type Workspace } from './workspace';

export interface PendingProposal {
  call: ToolCallInfo;
  explanation: string;
  file: FileProposal;
}

/** Turns a gated write call into hunks, or explains to the model why it cannot be shown. */
export async function proposalFromCall(ws: Workspace, call: ToolCallInfo): Promise<{ ok: true; p: PendingProposal } | { ok: false; reason: string }> {
  const a = call.args;
  const path = typeof a.path === 'string' ? a.path : '';
  let rel: string;
  try {
    rel = safeRel(ws.root, path);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const explanation = typeof a.explanation === 'string' ? a.explanation : '';
  const current = await ws.readFile(rel);
  if (call.name === 'create_file') {
    if (current != null) return { ok: false, reason: `${rel} already exists; use propose_edit with search/replace blocks instead.` };
    const content = typeof a.content === 'string' ? a.content : '';
    return { ok: true, p: { call, explanation, file: buildProposal(rel, null, content) } };
  }
  if (current == null) return { ok: false, reason: `${rel} does not exist; use create_file for new files, or check the path with list_files.` };
  const edits = normalizeEdits(a.edits);
  if (!edits.length) return { ok: false, reason: 'propose_edit needs at least one {old_text, new_text} block.' };
  const r = applySearchReplace(current, edits);
  if (!r.ok) return { ok: false, reason: `Could not place the edit in ${rel}: ${r.errors.join(' ')}` };
  if (r.text === current) return { ok: false, reason: `The edit to ${rel} changes nothing.` };
  return { ok: true, p: { call, explanation, file: buildProposal(rel, current, r.text) } };
}

/** Records what the user accepted, so the approved MCP call writes exactly that and nothing else. */
export function recordReview(book: ApprovalBook, p: PendingProposal, accepted: Set<string>): { allow: boolean; reason?: string } {
  const f = p.file;
  const total = f.hunks.length;
  const acceptedCount = f.hunks.filter(h => accepted.has(h.id)).length;
  const rejected = f.hunks.filter(h => !accepted.has(h.id));
  if (acceptedCount === 0) {
    return { allow: false, reason: `The user rejected all ${total} hunk(s) for ${f.path}. Nothing was written.` };
  }
  const finalText = acceptedCount === total ? f.proposed : applyHunks(f.original ?? '', f.hunks, accepted);
  const d: Decision = {
    kind: 'write',
    path: f.path,
    finalText,
    before: f.original,
    accepted: acceptedCount,
    total,
    rejectedNotes: rejected.map(h => `hunk ${h.id.split('#')[1]} (${summarizeHunk(h)})`),
  };
  book.record(p.call.name, p.call.args, d);
  return { allow: true };
}

export function recordCommand(book: ApprovalBook, call: ToolCallInfo) {
  book.record('run_command', call.args, { kind: 'run', command: String(call.args.command ?? '') });
}
