import type { Workspace } from './workspace';

/**
 * Budgeted retrieval for repositories that do not fit in a context window.
 * Files are split into symbol-sized chunks (Python defs/classes, doc sections, line windows),
 * ranked with BM25 plus symbol-name, path and intent boosts, then expanded along the import
 * graph (a chosen module pulls in the tests that import it). The pack is cut at a token budget
 * and records why each file is in and what was left out.
 */

export interface Chunk {
  file: string;
  start: number; // 1-based, inclusive
  end: number;
  kind: 'module' | 'def' | 'class' | 'section' | 'window';
  name: string;
  terms: Map<string, number>;
  nameTerms: Set<string>;
  length: number;
}

export interface FileEntry {
  path: string;
  lines: string[];
  chunks: Chunk[];
  pathTerms: Set<string>;
  imports: string[]; // dotted module names
  module: string | null; // dotted module name for Python files under src/ or the root
}

export interface PackedFile {
  path: string;
  score: number;
  reasons: string[];
  chunks: { start: number; end: number; name: string }[];
  tokens: number;
}

export interface ContextPack {
  query: string;
  budgetTokens: number;
  usedTokens: number;
  files: PackedFile[];
  omitted: { path: string; score: number; reason: string }[];
  indexedFiles: number;
  indexedChunks: number;
  text: string;
}

const TEXT_EXT = /\.(py|pyi|md|rst|txt|toml|cfg|ini|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|html|jinja|j2|css|sh|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift)$/i;
const STOP = new Set(
  ('a an and are as at be by for from has have if in into is it its of on or that the this to was were will with ' +
    'any all every each its it must should would can could also new add make use using used value values ' +
    'self def return import none true false class pass else elif try except finally raise lambda yield not ' +
    'let const var function export default null undefined').split(' '),
);

export function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('es') && /(ss|sh|ch|x)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  if (t.length > 5 && t.endsWith('ed')) return t.slice(0, -2);
  return t;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  for (const w of words) {
    const parts = w
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_\s]+/)
      .filter(Boolean);
    for (const p of parts) {
      const l = p.toLowerCase();
      if (l.length < 2 || STOP.has(l)) continue;
      out.push(stem(l));
    }
    if (parts.length > 1) {
      const whole = w.toLowerCase();
      if (!STOP.has(whole)) out.push(whole);
    }
  }
  return out;
}

function countTerms(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function pyModuleName(file: string): string | null {
  if (!file.endsWith('.py')) return null;
  let p = file.replace(/\.py$/, '');
  if (p.startsWith('src/')) p = p.slice(4);
  p = p.replace(/\/__init__$/, '');
  return p.split('/').join('.');
}

function pyImports(lines: string[], module: string | null): string[] {
  const out: string[] = [];
  const pkg = module ? module.split('.').slice(0, -1) : [];
  for (const line of lines) {
    let m = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(line);
    if (m) {
      const dots = m[1].length;
      let base: string;
      if (dots > 0) {
        const up = pkg.slice(0, Math.max(pkg.length - (dots - 1), 0));
        base = [...up, ...(m[2] ? [m[2]] : [])].join('.');
      } else base = m[2];
      if (base) out.push(base);
      // "from flask import cli" style: the imported names may be submodules.
      for (const name of m[3].replace(/[()]/g, '').split(',')) {
        const n = name.trim().split(/\s+/)[0];
        if (/^\w+$/.test(n)) out.push(`${base}.${n}`);
      }
      continue;
    }
    m = /^\s*import\s+([\w., ]+)$/.exec(line);
    if (m) for (const name of m[1].split(',')) out.push(name.trim().split(/\s+/)[0]);
  }
  return out;
}

function chunkPython(file: string, lines: string[]): Omit<Chunk, 'terms' | 'nameTerms' | 'length'>[] {
  const starts: { line: number; kind: 'def' | 'class'; name: string; indent: number }[] = [];
  lines.forEach((l, i) => {
    const m = /^(\s*)(?:async\s+)?(def|class)\s+(\w+)/.exec(l);
    if (m) {
      let s = i;
      while (s > 0 && /^\s*@/.test(lines[s - 1])) s--;
      starts.push({ line: s, kind: m[2] === 'class' ? 'class' : 'def', name: m[3], indent: m[1].length });
    }
  });
  const out: Omit<Chunk, 'terms' | 'nameTerms' | 'length'>[] = [];
  const first = starts.length ? starts[0].line : lines.length;
  if (first > 0) out.push({ file, start: 1, end: first, kind: 'module', name: '(module top)' });
  let currentClass: string | null = null;
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].line : lines.length;
    if (s.indent === 0) currentClass = s.kind === 'class' ? s.name : null;
    const name = s.indent > 0 && currentClass ? `${currentClass}.${s.name}` : s.name;
    // A class body chunk is only its header up to the first method; methods get their own chunks.
    out.push({ file, start: s.line + 1, end: Math.max(end, s.line + 1), kind: s.kind, name });
  });
  return out;
}

function chunkDoc(file: string, lines: string[]): Omit<Chunk, 'terms' | 'nameTerms' | 'length'>[] {
  const heads: { line: number; name: string }[] = [];
  lines.forEach((l, i) => {
    if (/^#{1,6}\s+\S/.test(l)) heads.push({ line: i, name: l.replace(/^#+\s*/, '').trim() });
    else if (i + 1 < lines.length && l.trim() && /^([=\-~^"'`*+#])\1{2,}\s*$/.test(lines[i + 1]) && lines[i + 1].trim().length >= Math.min(l.trim().length, 3)) {
      heads.push({ line: i, name: l.trim() });
    }
  });
  if (!heads.length) return chunkWindows(file, lines);
  const out: Omit<Chunk, 'terms' | 'nameTerms' | 'length'>[] = [];
  if (heads[0].line > 0) out.push({ file, start: 1, end: heads[0].line, kind: 'section', name: '(top)' });
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].line : lines.length;
    // Long sections are split so one huge section cannot eat the budget.
    for (let s = h.line; s < end; s += 80) out.push({ file, start: s + 1, end: Math.min(s + 80, end), kind: 'section', name: h.name });
  });
  return out;
}

function chunkWindows(file: string, lines: string[]): Omit<Chunk, 'terms' | 'nameTerms' | 'length'>[] {
  const out: Omit<Chunk, 'terms' | 'nameTerms' | 'length'>[] = [];
  for (let s = 0; s < Math.max(lines.length, 1); s += 60) out.push({ file, start: s + 1, end: Math.min(s + 60, lines.length), kind: 'window', name: `lines ${s + 1}-${Math.min(s + 60, lines.length)}` });
  return out;
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.6);
}

export interface RetrieveOptions {
  budgetTokens?: number;
  maxFiles?: number;
  /** Files the user named with @file; always first, never dropped for score. */
  pinned?: string[];
  /** Files open in the editor get a small boost. */
  open?: string[];
  /** Use only BM25 over whole files (the baseline in the evidence replay). */
  baseline?: boolean;
}

export class Retriever {
  files = new Map<string, FileEntry>();
  private chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private builtAt = 0;

  constructor(private ws: Workspace) {}

  get size() {
    return { files: this.files.size, chunks: this.chunks.length, builtAt: this.builtAt };
  }

  async build(): Promise<void> {
    const list = (await this.ws.listFiles()).filter(f => TEXT_EXT.test(f));
    this.files.clear();
    this.chunks = [];
    for (const f of list) {
      const text = await this.ws.readFile(f);
      if (text == null) continue;
      this.addFile(f, text);
    }
    this.recount();
    this.builtAt = Date.now();
  }

  /** Re-index one file after an edit, so later turns see the new symbols. */
  update(path: string, text: string | null) {
    this.chunks = this.chunks.filter(c => c.file !== path);
    this.files.delete(path);
    if (text != null && TEXT_EXT.test(path)) this.addFile(path, text);
    this.recount();
  }

  private addFile(path: string, text: string) {
    const lines = text.split(/\r?\n/);
    const isPy = /\.pyi?$/.test(path);
    const isDoc = /\.(md|rst|txt)$/i.test(path);
    const raw = isPy ? chunkPython(path, lines) : isDoc ? chunkDoc(path, lines) : chunkWindows(path, lines);
    const chunks: Chunk[] = raw.map(r => {
      const body = lines.slice(r.start - 1, r.end).join('\n');
      const toks = tokenize(body);
      return { ...r, terms: countTerms(toks), nameTerms: new Set(tokenize(r.name)), length: Math.max(toks.length, 1) };
    });
    const module = pyModuleName(path);
    this.files.set(path, { path, lines, chunks, pathTerms: new Set(tokenize(path.replace(/[/.]/g, ' '))), imports: isPy ? pyImports(lines, module) : [], module });
    this.chunks.push(...chunks);
  }

  private recount() {
    this.df.clear();
    let total = 0;
    for (const c of this.chunks) {
      total += c.length;
      for (const t of c.terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
  }

  private idf(t: string): number {
    const n = this.chunks.length;
    const d = this.df.get(t) ?? 0;
    return Math.log(1 + (n - d + 0.5) / (d + 0.5));
  }

  private bm25(c: Chunk, q: string[]): { score: number; hits: string[] } {
    const k1 = 1.2;
    const b = 0.75;
    let s = 0;
    const hits: string[] = [];
    for (const t of q) {
      const tf = c.terms.get(t) ?? 0;
      if (!tf) continue;
      hits.push(t);
      s += this.idf(t) * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.length) / this.avgLen)));
    }
    return { score: s, hits };
  }

  /** Ranks files for a request. Returns every file with a positive score, best first, with reasons. */
  /** Query terms that carry signal: terms present in more than a quarter of all chunks (the project name, say) are dropped. */
  queryTerms(query: string): string[] {
    const n = Math.max(this.chunks.length, 1);
    const all = [...new Set(tokenize(query))];
    const kept = all.filter(t => (this.df.get(t) ?? 0) / n <= 0.25);
    return kept.length ? kept : all;
  }

  rank(query: string, opts: RetrieveOptions = {}): { path: string; score: number; reasons: string[]; top: Chunk[] }[] {
    const q = opts.baseline ? [...new Set(tokenize(query))] : this.queryTerms(query);
    const wantsTests = /\btest(s|ed|ing)?\b|covered|coverage/i.test(query);
    const wantsDocs = /\bdoc(s|ument|umented|umentation)?\b|readme/i.test(query);
    const wantsChange = /\b(add|implement|fix|change|update|create|make|support|treat|rename|remove|refactor|introduce)\b/i.test(query);
    const perFile = new Map<string, { scored: { c: Chunk; s: number; hits: string[] }[]; reasons: Set<string>; bonus: number }>();

    for (const c of this.chunks) {
      const { score, hits } = this.bm25(c, q);
      if (score <= 0) continue;
      let s = score;
      const nameHits = q.filter(t => c.nameTerms.has(t));
      if (!opts.baseline && nameHits.length) s += 1.5 * nameHits.length;
      const e = perFile.get(c.file) ?? { scored: [], reasons: new Set<string>(), bonus: 0 };
      e.scored.push({ c, s, hits: [...new Set([...hits, ...nameHits])] });
      perFile.set(c.file, e);
    }

    const results: { path: string; score: number; reasons: string[]; top: Chunk[] }[] = [];
    for (const [path, e] of perFile) {
      const f = this.files.get(path);
      if (!f) continue;
      e.scored.sort((a, b) => b.s - a.s);
      let score = e.scored[0].s + 0.5 * (e.scored[1]?.s ?? 0) + 0.25 * (e.scored[2]?.s ?? 0);
      const reasons: string[] = [];
      const best = e.scored[0];
      reasons.push(`matches ${best.hits.slice(0, 4).map(h => `"${h}"`).join(', ')} in ${best.c.name} (L${best.c.start})`);
      if (!opts.baseline) {
        const pathHits = q.filter(t => f.pathTerms.has(t));
        if (pathHits.length) {
          score += 1.2 * pathHits.length;
          reasons.push(`path matches ${pathHits.map(h => `"${h}"`).join(', ')}`);
        }
        const isTest = /(^|\/)tests?\//.test(path) || /(^|\/)test_[^/]+$/.test(path);
        const isDoc = /\.(rst|md)$/i.test(path) || path.startsWith('docs/');
        // Breadth: a file that touches more of the request beats one that repeats a single word.
        const covered = new Set<string>();
        for (const c of f.chunks) for (const t of q) if (c.terms.has(t) || c.nameTerms.has(t)) covered.add(t);
        // Coverage is weighted by idf, so rare words of the request ("cli", "help") count more than common ones.
        const idfAll = q.reduce((a, t) => a + this.idf(t), 0) || 1;
        const coverage = [...covered].reduce((a, t) => a + this.idf(t), 0) / idfAll;
        score *= 0.4 + 1.2 * coverage;
        if (wantsChange && !isTest && !isDoc && /\.(py|ts|tsx|js|go|rs|java|rb|php)$/.test(path)) {
          score *= 1.3;
          reasons.push('source the change will likely edit');
        }
        if (wantsTests && isTest) {
          score *= 1.35;
          reasons.push('the task asks for a test');
        }
        if (wantsDocs && isDoc) {
          score *= 1.35;
          reasons.push('the task asks for documentation');
        }
        if (/^(CHANGES|CHANGELOG|HISTORY)/i.test(path)) score *= 0.6;
        if (opts.open?.includes(path)) {
          score *= 1.15;
          reasons.push('open in the editor');
        }
      }
      results.push({ path, score, reasons, top: e.scored.slice(0, 3).map(x => x.c) });
    }
    results.sort((a, b) => b.score - a.score);
    if (opts.baseline) return results;

    // Import-graph expansion: tests that import a top-ranked module are pulled up with it.
    const top = results.slice(0, 6).filter(r => this.files.get(r.path)?.module);
    for (const r of top) {
      const mod = this.files.get(r.path)!.module!;
      for (const other of results) {
        if (other.path === r.path) continue;
        const of = this.files.get(other.path);
        if (!of) continue;
        if (of.imports.some(i => i === mod || i.startsWith(mod + '.'))) {
          const isTest = /(^|\/)tests?\//.test(other.path);
          const lift = isTest ? 0.55 : 0.25;
          if (other.score < r.score * lift + other.score * 0.5) {
            other.score = Math.max(other.score, r.score * lift + other.score * 0.5);
          }
          other.reasons.push(`imports ${mod} (${isTest ? 'its tests' : 'a dependent'})`);
        }
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  retrieve(query: string, opts: RetrieveOptions = {}): ContextPack {
    const budget = opts.budgetTokens ?? 10_000;
    const maxFiles = opts.maxFiles ?? 8;
    const ranked = this.rank(query, opts);
    const pinned = (opts.pinned ?? []).filter(p => this.files.has(p));
    // Role slots: a change usually needs its code, its tests and its docs. The best file of each
    // requested role goes first, if it is a reasonable match, so one role cannot crowd out the others.
    const roles: ((p: string) => boolean)[] = [p => !/(^|\/)tests?\//.test(p) && !/\.(rst|md|txt)$/i.test(p) && !p.startsWith('docs/')];
    if (/\btest(s|ed|ing)?\b|covered|coverage/i.test(query)) roles.push(p => /(^|\/)tests?\//.test(p));
    if (/\bdoc(s|ument|umented|umentation)?\b|readme/i.test(query)) roles.push(p => /\.(rst|md)$/i.test(p) || p.startsWith('docs/'));
    const lead: typeof ranked = [];
    if (!opts.baseline && ranked.length) {
      roles.forEach((role, i) => {
        const candidates = ranked.filter(r => role(r.path) && !pinned.includes(r.path) && !lead.includes(r));
        let best = candidates[0];
        if (!best) return;
        // Tests and docs that belong to the chosen code beat ones that only share words with the request.
        const code = lead[0] ? this.files.get(lead[0].path) : undefined;
        if (i > 0 && code) {
          const stem = code.path.split('/').pop()!.replace(/\.\w+$/, '');
          const sibling = candidates.find(
            r =>
              r.score >= best.score * 0.5 &&
              ((code.module && this.files.get(r.path)?.imports.some(m => m === code.module || m.startsWith(code.module + '.'))) ||
                r.path.split('/').pop()!.replace(/\.\w+$/, '').replace(/^test_/, '') === stem),
          );
          if (sibling) {
            sibling.reasons.push(`belongs with ${code.path}`);
            best = sibling;
          }
        }
        if (best.score >= ranked[0].score * 0.3) {
          best.reasons.push(i === 0 ? 'best code match' : i === 1 ? 'best test match' : 'best docs match');
          lead.push(best);
        }
      });
    }
    const order = [
      ...pinned.map(p => ({ path: p, score: Infinity, reasons: ['you mentioned it'], top: this.files.get(p)!.chunks.slice(0, 3) })),
      ...lead,
      ...ranked.filter(r => !pinned.includes(r.path) && !lead.includes(r)),
    ];
    const packed: PackedFile[] = [];
    const omitted: ContextPack['omitted'] = [];
    let used = 0;
    const parts: string[] = [];
    const header = `Context for: ${query}\nBudget: ${budget} tokens. Files were chosen by Countersign's retriever; line numbers are 1-based.\n`;
    used += estimateTokens(header);
    const topScore = order.find(o => Number.isFinite(o.score))?.score ?? 1;

    for (const r of order) {
      const f = this.files.get(r.path)!;
      if (packed.length >= maxFiles) {
        omitted.push({ path: r.path, score: r.score, reason: `beyond the ${maxFiles}-file limit` });
        continue;
      }
      if (Number.isFinite(r.score) && r.score < topScore * 0.18) {
        omitted.push({ path: r.path, score: r.score, reason: 'weak match' });
        continue;
      }
      const outline = f.chunks
        .filter(c => c.kind === 'def' || c.kind === 'class' || c.kind === 'section')
        .map(c => `${c.name}:${c.start}`)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 40)
        .join(', ');
      const block: string[] = [`\n### ${r.path}\nWhy: ${r.reasons.join('; ')}\nOutline: ${outline || '(none)'}`];
      const chosenChunks: PackedFile['chunks'] = [];
      let fileTokens = estimateTokens(block[0]);
      if (used + fileTokens > budget) {
        omitted.push({ path: r.path, score: r.score, reason: 'over the token budget' });
        continue;
      }
      for (const c of r.top) {
        const end = Math.min(c.end, c.start + 119);
        const body = f.lines
          .slice(c.start - 1, end)
          .map((l, i) => `${String(c.start + i).padStart(5)}| ${l}`)
          .join('\n');
        const piece = `\n[${c.name}, lines ${c.start}-${end}]\n${body}`;
        const t = estimateTokens(piece);
        if (used + fileTokens + t > budget) break;
        block.push(piece);
        fileTokens += t;
        chosenChunks.push({ start: c.start, end, name: c.name });
      }
      used += fileTokens;
      parts.push(block.join('\n'));
      packed.push({ path: r.path, score: Number.isFinite(r.score) ? r.score : 999, reasons: r.reasons, chunks: chosenChunks, tokens: fileTokens });
    }
    const leftOut = omitted.length
      ? `\n\nLeft out (${omitted.length}): ${omitted
          .slice(0, 12)
          .map(o => `${o.path} (${o.reason})`)
          .join(', ')}${omitted.length > 12 ? ', ...' : ''}`
      : '';
    return {
      query,
      budgetTokens: budget,
      usedTokens: used,
      files: packed,
      omitted,
      indexedFiles: this.files.size,
      indexedChunks: this.chunks.length,
      text: header + parts.join('\n') + leftOut,
    };
  }

  /** A compact symbol map of the repo, most relevant files first when a query is given. */
  repoMap(query: string | undefined, budgetTokens = 3000): string {
    const ranked = query ? this.rank(query).map(r => r.path) : [];
    const rest = [...this.files.keys()].filter(p => !ranked.includes(p));
    const out: string[] = [];
    let used = 0;
    for (const p of [...ranked, ...rest]) {
      const f = this.files.get(p)!;
      const syms = f.chunks.filter(c => c.kind === 'def' || c.kind === 'class').map(c => c.name);
      const line = syms.length ? `${p}: ${syms.slice(0, 25).join(', ')}${syms.length > 25 ? ` (+${syms.length - 25})` : ''}` : p;
      const t = estimateTokens(line);
      if (used + t > budgetTokens) {
        out.push(`... ${this.files.size - out.length} more files`);
        break;
      }
      out.push(line);
      used += t;
    }
    return out.join('\n');
  }

  findSymbol(name: string): { file: string; line: number; kind: string; name: string }[] {
    const want = name.toLowerCase();
    const exact: Chunk[] = [];
    const partial: Chunk[] = [];
    for (const c of this.chunks) {
      if (c.kind !== 'def' && c.kind !== 'class') continue;
      const n = c.name.toLowerCase();
      const short = n.split('.').pop()!;
      if (n === want || short === want) exact.push(c);
      else if (n.includes(want)) partial.push(c);
    }
    return [...exact, ...partial].slice(0, 30).map(c => ({ file: c.file, line: c.start, kind: c.kind, name: c.name }));
  }

  symbolsFor(prefix: string, limit = 30): { file: string; line: number; name: string }[] {
    const p = prefix.toLowerCase();
    return this.chunks
      .filter(c => (c.kind === 'def' || c.kind === 'class') && c.name.toLowerCase().includes(p))
      .slice(0, limit)
      .map(c => ({ file: c.file, line: c.start, name: c.name }));
  }
}
