import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** What the agent's tools may touch. The VS Code side backs it with open buffers; the harness with disk. */
export interface Workspace {
  root: string;
  listFiles(): Promise<string[]>;
  /** Current text, including unsaved editor changes where the host has them. */
  readFile(rel: string): Promise<string | null>;
  /** Only called from inside an approved tool call. */
  writeFile(rel: string, text: string): Promise<void>;
  deleteFile(rel: string): Promise<void>;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', 'dist', 'build', 'out', '.vscode-test']);
const MAX_BYTES = 400_000;

/** PATH as the extension host started with it: never includes anything from the workspace. */
const HOST_PATH = process.env.PATH ?? '/usr/bin:/bin';

/**
 * Runs a helper (git) with a fixed environment and, for git, repository config that cannot run
 * commands (fsmonitor, hooks, external diff, pager), so opening a hostile repo runs nothing from it.
 */
export function run(cmd: string, args: string[], cwd: string, timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const safeArgs = cmd === 'git' ? ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat', '--no-pager', ...args] : args;
  const env = { PATH: HOST_PATH, HOME: process.env.HOME ?? '', LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  return new Promise(resolve => {
    execFile(cmd, safeArgs, { cwd, timeout: timeoutMs, maxBuffer: 20_000_000, env }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Paths the agent may never touch: git internals and secret env files (examples are fine). */
const FORBIDDEN = [/(^|\/)\.git(\/|$)/, /(^|\/)\.env$/, /(^|\/)\.env\.(?!example$|sample$|template$)[^/]+$/];

/** Rejects paths that escape the workspace (.., absolute paths), odd characters, and forbidden files. */
export function safeRel(root: string, rel: string): string {
  if (typeof rel !== 'string' || !rel.trim() || /[\0-\x1f"'<>`]/.test(rel)) throw new Error(`path "${String(rel)}" is not allowed`);
  const cleaned = rel.replace(/^\.\/+/, '').replace(/\\/g, '/');
  const abs = path.resolve(root, cleaned);
  const back = path.relative(root, abs);
  if (back.startsWith('..') || path.isAbsolute(back) || back === '') {
    throw new Error(`path "${rel}" is outside the workspace`);
  }
  const out = back.split(path.sep).join('/');
  if (FORBIDDEN.some(r => r.test(out))) throw new Error(`path "${out}" is off limits (git internals or secrets)`);
  return out;
}

/**
 * The real location must stay inside the real workspace, so a symlink in the repo cannot lead a read
 * or an approved write somewhere else. For new files the nearest existing parent is checked.
 */
export async function assertInside(root: string, rel: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  let p = path.join(root, rel);
  for (;;) {
    try {
      const real = await fs.realpath(p);
      const back = path.relative(realRoot, real);
      if (back.startsWith('..') || path.isAbsolute(back)) throw new Error(`path "${rel}" resolves outside the workspace`);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const up = path.dirname(p);
      if (up === p) return;
      p = up;
    }
  }
}

export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const git = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], root);
  if (git.code === 0 && git.stdout.trim()) {
    return git.stdout.split('\n').map(s => s.trim()).filter(Boolean).sort();
  }
  const out: string[] = [];
  async function walk(dir: string) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) await walk(path.join(dir, ent.name));
      } else if (ent.isFile()) {
        out.push(path.relative(root, path.join(dir, ent.name)).split(path.sep).join('/'));
      }
    }
  }
  await walk(root);
  return out.sort();
}

export class NodeWorkspace implements Workspace {
  constructor(public root: string) {}
  listFiles() {
    return listWorkspaceFiles(this.root);
  }
  async readFile(rel: string) {
    try {
      const r = safeRel(this.root, rel);
      const p = path.join(this.root, r);
      await assertInside(this.root, r);
      const st = await fs.stat(p);
      if (!st.isFile() || st.size > MAX_BYTES) return null;
      return await fs.readFile(p, 'utf8');
    } catch {
      return null;
    }
  }
  async writeFile(rel: string, text: string) {
    const r = safeRel(this.root, rel);
    await assertInside(this.root, r);
    const p = path.join(this.root, r);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, text, 'utf8');
  }
  async deleteFile(rel: string) {
    await fs.rm(path.join(this.root, safeRel(this.root, rel)), { force: true });
  }
}

export async function gitStatus(root: string): Promise<string | null> {
  const r = await run('git', ['status', '--porcelain'], root);
  return r.code === 0 ? r.stdout.trim() : null;
}
