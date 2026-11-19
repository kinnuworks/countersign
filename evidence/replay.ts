/**
 * Back-test of Countersign's retriever on pallets/flask history (evidence/EVAL_PLAN.md).
 * For each selected commit, the repository is rebuilt at the commit's parent from git objects,
 * the commit message is the request, and we check whether the files the commit edited land in
 * each method's 10,000-token pack. Baseline: BM25 over whole files (SWE-bench's retriever).
 *
 *   node out/replay.js <flask-git-dir> [--out evidence/results/replay.csv]
 */
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Retriever, estimateTokens, tokenize } from '../src/core/retriever';
import type { Workspace } from '../src/core/workspace';

const BUDGET = 10_000;
const TEXT = /\.(py|pyi|md|rst|txt|toml|cfg|ini|ts|js|json|ya?ml|html|jinja|j2|css|sh)$/i;
const SKIP_SUBJECT = /^(Merge|Bump|Release|release version|\[pre-commit|update requirements|Update requirements)/;

class BlobReader {
  private proc;
  private buf = Buffer.alloc(0);
  private queue: { resolve: (s: string | null) => void }[] = [];
  private cache = new Map<string, string | null>();
  constructor(repo: string) {
    this.proc = spawn('git', ['cat-file', '--batch'], { cwd: repo });
    this.proc.stdout.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
  }
  private drain() {
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl < 0 || !this.queue.length) return;
      const header = this.buf.subarray(0, nl).toString();
      if (header.endsWith('missing')) {
        this.buf = this.buf.subarray(nl + 1);
        this.queue.shift()!.resolve(null);
        continue;
      }
      const size = Number(header.split(' ')[2]);
      if (this.buf.length < nl + 1 + size + 1) return;
      const body = this.buf.subarray(nl + 1, nl + 1 + size).toString('utf8');
      this.buf = this.buf.subarray(nl + 1 + size + 1);
      this.queue.shift()!.resolve(body);
    }
  }
  read(sha: string): Promise<string | null> {
    if (this.cache.has(sha)) return Promise.resolve(this.cache.get(sha)!);
    return new Promise(resolve => {
      this.queue.push({
        resolve: v => {
          this.cache.set(sha, v);
          resolve(v);
        },
      });
      this.proc.stdin.write(sha + '\n');
    });
  }
  close() {
    this.proc.stdin.end();
  }
}

/** The repository at one commit, straight from git objects (nothing checked out). */
class TreeWorkspace implements Workspace {
  root = '/tree';
  private files = new Map<string, { sha: string; size: number }>();
  constructor(private repo: string, private commit: string, private blobs: BlobReader) {
    const out = execFileSync('git', ['ls-tree', '-r', '-l', commit], { cwd: repo, maxBuffer: 50_000_000 }).toString();
    for (const line of out.split('\n')) {
      const m = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(line);
      if (m) this.files.set(m[3], { sha: m[1], size: Number(m[2]) });
    }
  }
  async listFiles() {
    return [...this.files.keys()].sort();
  }
  async readFile(rel: string) {
    const f = this.files.get(rel);
    if (!f || f.size > 400_000) return null;
    return this.blobs.read(f.sha);
  }
  has(rel: string) {
    return this.files.has(rel);
  }
  async writeFile() {
    throw new Error('read-only');
  }
  async deleteFile() {
    throw new Error('read-only');
  }
}

/** SWE-bench-style baseline: BM25 over whole files, whole files packed in rank order up to the budget. */
async function bm25WholeFiles(ws: TreeWorkspace, query: string) {
  const files = (await ws.listFiles()).filter(f => TEXT.test(f));
  const docs: { path: string; tf: Map<string, number>; len: number; tokens: number }[] = [];
  for (const f of files) {
    const t = await ws.readFile(f);
    if (t == null) continue;
    const toks = tokenize(t + ' ' + f.replace(/[/.]/g, ' '));
    const tf = new Map<string, number>();
    for (const x of toks) tf.set(x, (tf.get(x) ?? 0) + 1);
    docs.push({ path: f, tf, len: Math.max(toks.length, 1), tokens: estimateTokens(t) });
  }
  const df = new Map<string, number>();
  for (const d of docs) for (const k of d.tf.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(docs.length, 1);
  const q = [...new Set(tokenize(query))];
  const N = docs.length;
  const scored = docs
    .map(d => {
      let s = 0;
      for (const t of q) {
        const tf = d.tf.get(t) ?? 0;
        if (!tf) continue;
        const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        s += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.len) / avg)));
      }
      return { path: d.path, s, tokens: d.tokens };
    })
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const pack: string[] = [];
  let used = 0;
  for (const d of scored) {
    if (used + d.tokens > BUDGET) continue; // SWE-bench skips files that do not fit and keeps filling
    pack.push(d.path);
    used += d.tokens;
  }
  return { ranked: scored.map(x => x.path), pack };
}

async function main() {
  const repo = path.resolve(process.argv[2] ?? '.ref/flask');
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '3.1.3^{commit}'], { stdio: 'ignore' });
  } catch {
    console.error(`replay: ${repo} is not a pallets/flask clone with tag 3.1.3 (git clone https://github.com/pallets/flask ${repo})`);
    process.exit(2);
  }
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > 0 ? process.argv[outIdx + 1] : 'evidence/results/replay.csv';
  const log = execFileSync('git', ['log', '--no-merges', '--format=%H%x1f%P%x1f%cI%x1f%s%x1f%b%x1e', '3.1.3'], { cwd: repo, maxBuffer: 200_000_000 }).toString();
  const commits = log
    .split('\x1e')
    .map(r => r.trim())
    .filter(Boolean)
    .map(r => {
      const [sha, parents, date, subject, body] = r.split('\x1f');
      return { sha, parent: parents.split(' ')[0], date, subject: subject.trim(), body: (body ?? '').trim() };
    })
    .filter(c => c.parent && c.subject.length >= 20 && !SKIP_SUBJECT.test(c.subject) && c.date >= '2021-05-11');
  const blobs = new BlobReader(repo);
  const rows: string[] = ['sha,date,slice,targets,ours_all,base_all,ours_recall5,base_recall5,ours_files,base_files'];
  let kept = 0;
  for (const c of commits) {
    const changed = execFileSync('git', ['diff', '--name-status', c.parent, c.sha], { cwd: repo }).toString().trim().split('\n');
    const modified = changed.filter(l => l.startsWith('M\t')).map(l => l.slice(2));
    const ws = new TreeWorkspace(repo, c.parent, blobs);
    const targets = modified.filter(f => TEXT.test(f) && f !== 'CHANGES.rst' && ws.has(f));
    if (targets.length < 2 || targets.length > 8) continue;
    const query = `${c.subject}\n${c.body}`.slice(0, 600);
    const r = new Retriever(ws);
    await r.build();
    const pack = r.retrieve(query, { budgetTokens: BUDGET });
    const oursPack = new Set(pack.files.map(f => f.path));
    const oursTop5 = r.rank(query).slice(0, 5).map(x => x.path);
    // Ours, as the agent sees it: the role-slot lead files come first in the pack, so use pack order for top 5.
    const oursFirst5 = [...pack.files.map(f => f.path), ...oursTop5.filter(p => !oursPack.has(p))].slice(0, 5);
    const base = await bm25WholeFiles(ws, query);
    const basePack = new Set(base.pack);
    const all = (s: Set<string>) => (targets.every(t => s.has(t)) ? 1 : 0);
    const rec = (list: string[]) => targets.filter(t => list.includes(t)).length / targets.length;
    const slice = c.date >= '2023-01-01' ? 'test' : 'build';
    rows.push([c.sha.slice(0, 8), c.date.slice(0, 10), slice, targets.join('|'), all(oursPack), all(basePack), rec(oursFirst5).toFixed(3), rec(base.ranked.slice(0, 5)).toFixed(3), pack.files.length, base.pack.length].join(','));
    kept++;
    if (kept % 25 === 0) console.error(`${kept} commits...`);
  }
  blobs.close();
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, rows.join('\n') + '\n');
  console.log(`wrote ${out}: ${kept} commits`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
