import { structuredPatch } from 'diff';

export interface SearchReplace {
  old_text: string;
  new_text: string;
}

/** Models differ: some send edits as an array, some as a JSON string, some as one object. */
export function normalizeEdits(raw: unknown): SearchReplace[] {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (v && !Array.isArray(v) && typeof v === 'object') v = [v];
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is SearchReplace => !!e && typeof e.old_text === 'string' && typeof e.new_text === 'string').map(e => ({ old_text: e.old_text, new_text: e.new_text }));
}

export interface EditResult {
  ok: boolean;
  text: string;
  errors: string[];
}

export interface Hunk {
  /** Stable within one proposal: "<file>#<n>". */
  id: string;
  oldStart: number; // 1-based line in the original
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Unified-diff body lines, each starting with ' ', '+' or '-'. */
  lines: string[];
  /** Set when this hunk adds ('add') or removes ('remove') the file's final newline. */
  eof?: 'add' | 'remove';
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    // Step one character, not one match: 'aa' occurs twice in 'aaa', and that must count as ambiguous.
    i = haystack.indexOf(needle, i + 1);
  }
  return n;
}

/**
 * Finds `oldText` ignoring trailing whitespace and indentation differences line by line.
 * Models often re-indent or drop trailing spaces in search blocks; an exact match is tried first.
 */
function fuzzyFind(text: string, oldText: string): { start: number; end: number } | 'ambiguous' | null {
  const lines = text.split('\n');
  const want = oldText.replace(/\n+$/, '').split('\n').map(l => l.trim());
  if (want.length === 0 || want.every(l => l === '')) return null;
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let match = true;
    for (let j = 0; j < want.length; j++) {
      if (lines[i + j].trim() !== want[j]) {
        match = false;
        break;
      }
    }
    if (match) hits.push(i);
  }
  if (hits.length === 0) return null;
  if (hits.length > 1) return 'ambiguous';
  const first = hits[0];
  const last = first + want.length - 1;
  return { start: offsets[first], end: offsets[last] + lines[last].replace(/\r$/, '').length };
}

/** Applies search/replace blocks in order. Every block must match exactly one place. */
export function applySearchReplace(original: string, rawEdits: SearchReplace[]): EditResult {
  let text = original;
  // Keep the file's line endings: models write \n, a CRLF file must stay CRLF.
  const crlf = original.includes('\r\n');
  const edits = crlf ? rawEdits.map(e => ({ old_text: e.old_text, new_text: e.new_text.replace(/\r?\n/g, '\r\n') })) : rawEdits;
  const errors: string[] = [];
  edits.forEach((e, idx) => {
    const label = `edit ${idx + 1}`;
    if (e.old_text === '') {
      errors.push(`${label}: old_text is empty; use create_file for new files or include the lines you are replacing`);
      return;
    }
    const oldText = crlf && !e.old_text.includes('\r\n') ? e.old_text.replace(/\n/g, '\r\n') : e.old_text;
    const exact = countOccurrences(text, oldText);
    if (exact === 1) {
      text = text.replace(oldText, () => e.new_text);
      return;
    }
    if (exact > 1) {
      errors.push(`${label}: old_text matches ${exact} places; include more surrounding lines so it is unique`);
      return;
    }
    const f = fuzzyFind(text, e.old_text);
    if (f === 'ambiguous') {
      errors.push(`${label}: old_text matches several places when whitespace is ignored; include more surrounding lines`);
      return;
    }
    if (!f) {
      errors.push(`${label}: old_text was not found in the current file; read the file again and copy the exact lines`);
      return;
    }
    // Keep the file's own indentation of the first matched line when the model dropped it.
    const matched = text.slice(f.start, f.end);
    const indentHave = /^[ \t]*/.exec(matched)?.[0] ?? '';
    const indentGot = /^[ \t]*/.exec(e.old_text)?.[0] ?? '';
    const nl = crlf ? '\r\n' : '\n';
    let replacement = e.new_text.replace(/(\r?\n)+$/, '');
    if (indentHave !== indentGot && indentGot === '') {
      replacement = replacement
        .split(/\r?\n/)
        .map(l => (l.length ? indentHave + l : l))
        .join(nl);
    }
    text = text.slice(0, f.start) + replacement + text.slice(f.end);
  });
  return { ok: errors.length === 0, text, errors };
}

/**
 * Splits the change into reviewable hunks. No context lines inside a hunk, so two edits a couple
 * of lines apart (a docstring and the code under it) can be accepted or rejected separately;
 * displays add surrounding lines themselves.
 */
export function computeHunks(file: string, original: string, proposed: string): Hunk[] {
  const patch = structuredPatch(file, file, original, proposed, '', '', { context: 0 });
  return patch.hunks.map((h, i) => {
    // jsdiff marks a side without a final newline with a '\\ No newline' line after that side's last line.
    let oldNoNl = false, newNoNl = false;
    h.lines.forEach((l, j) => {
      if (!l.startsWith('\\') || j === 0) return;
      const prev = h.lines[j - 1][0];
      if (prev === '-' || prev === ' ') oldNoNl = true;
      if (prev === '+' || prev === ' ') newNoNl = true;
    });
    const hunk: Hunk = {
      id: `${file}#${i + 1}`,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines.filter(l => !l.startsWith('\\')),
    };
    if (oldNoNl !== newNoNl && original !== '') hunk.eof = oldNoNl ? 'add' : 'remove';
    if (original === '' && newNoNl) hunk.eof = 'remove';
    return hunk;
  });
}

/**
 * Rebuilds the file from the original plus only the accepted hunks.
 * Hunks never overlap (jsdiff merges close ones), so applying bottom-up keeps line numbers valid.
 */
export function applyHunks(original: string, hunks: Hunk[], accepted: Set<string>): string {
  // A file with no line break yet (or a new one) takes its line endings from the proposal
  // (jsdiff keeps the \r on CRLF lines).
  const crlf = original.includes('\n') ? original.includes('\r\n') : hunks.some(h => h.lines.some(l => l.endsWith('\r')));
  const eol = crlf ? '\r\n' : '\n';
  // The final newline is kept as a flag, not as a line, so the array matches jsdiff's line numbers.
  // A new file ends with one unless its hunk says otherwise.
  let finalNl = original === '' || /\n$/.test(original);
  const lines = original === '' ? [] : original.replace(/\r?\n$/, '').split(/\r?\n/);
  const chosen = hunks.filter(h => accepted.has(h.id)).sort((a, b) => b.oldStart - a.oldStart);
  for (const h of chosen) {
    // jsdiff keeps a trailing \r on lines of CRLF files; strip it, since lines are rejoined with eol.
    const replacement = h.lines.filter(l => !l.startsWith('-')).map(l => l.slice(1).replace(/\r$/, ''));
    // jsdiff numbers a pure insertion by the old line it goes before, so every hunk starts at oldStart - 1.
    const start = Math.max(0, h.oldStart - 1);
    lines.splice(start, h.oldLines, ...replacement);
    if (h.eof) finalNl = h.eof === 'add';
  }
  if (lines.length === 0) return '';
  return lines.join(eol) + (finalNl ? eol : '');
}

export interface FileProposal {
  path: string;
  /** null when the file does not exist yet. */
  original: string | null;
  proposed: string;
  hunks: Hunk[];
}

export function buildProposal(path: string, original: string | null, proposed: string): FileProposal {
  return { path, original, proposed, hunks: computeHunks(path, original ?? '', proposed) };
}

export function summarizeHunk(h: Hunk): string {
  const added = h.lines.filter(l => l.startsWith('+')).length;
  const removed = h.lines.filter(l => l.startsWith('-')).length;
  if (h.oldLines === 0) return `insert at line ${h.oldStart}: +${added}`;
  const end = h.oldStart + h.oldLines - 1;
  return `${end > h.oldStart ? `lines ${h.oldStart}-${end}` : `line ${h.oldStart}`}: +${added} -${removed}`;
}
