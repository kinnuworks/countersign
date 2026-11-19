import { structuredPatch } from 'diff';

export interface SearchReplace {
  old_text: string;
  new_text: string;
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
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
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
  return { start: offsets[first], end: offsets[last] + lines[last].length };
}

/** Applies search/replace blocks in order. Every block must match exactly one place. */
export function applySearchReplace(original: string, edits: SearchReplace[]): EditResult {
  let text = original;
  const errors: string[] = [];
  edits.forEach((e, idx) => {
    const label = `edit ${idx + 1}`;
    if (e.old_text === '') {
      errors.push(`${label}: old_text is empty; use create_file for new files or include the lines you are replacing`);
      return;
    }
    const exact = countOccurrences(text, e.old_text);
    if (exact === 1) {
      text = text.replace(e.old_text, () => e.new_text);
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
    let replacement = e.new_text.replace(/\n+$/, '');
    if (indentHave !== indentGot && indentGot === '') {
      replacement = replacement
        .split('\n')
        .map(l => (l.length ? indentHave + l : l))
        .join('\n');
    }
    text = text.slice(0, f.start) + replacement + text.slice(f.end);
  });
  return { ok: errors.length === 0, text, errors };
}

/** Splits the change into reviewable hunks (2 lines of context, so nearby edits stay separate). */
export function computeHunks(file: string, original: string, proposed: string): Hunk[] {
  const patch = structuredPatch(file, file, original, proposed, '', '', { context: 2 });
  return patch.hunks.map((h, i) => ({
    id: `${file}#${i + 1}`,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines.filter(l => !l.startsWith('\\')),
  }));
}

/**
 * Rebuilds the file from the original plus only the accepted hunks.
 * Hunks never overlap (jsdiff merges close ones), so applying bottom-up keeps line numbers valid.
 */
export function applyHunks(original: string, hunks: Hunk[], accepted: Set<string>): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  // An empty original has no lines; split('') would give one phantom empty line.
  const lines = original === '' ? [] : original.split(/\r?\n/);
  const chosen = hunks.filter(h => accepted.has(h.id)).sort((a, b) => b.oldStart - a.oldStart);
  for (const h of chosen) {
    const replacement = h.lines.filter(l => !l.startsWith('-')).map(l => l.slice(1));
    // jsdiff reports oldStart = 0 for an insertion into an empty file.
    const start = original === '' ? 0 : h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    lines.splice(start, h.oldLines, ...replacement);
  }
  return lines.join(eol);
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
  return `lines ${h.oldStart}-${h.oldStart + Math.max(h.oldLines - 1, 0)}: +${added} -${removed}`;
}
