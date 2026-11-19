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

export function run(cmd: string, args: string[], cwd: string, timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 20_000_000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Rejects paths that escape the workspace (.., absolute paths, symlink tricks are out of scope). */
export function safeRel(root: string, rel: string): string {
  const cleaned = rel.replace(/^\.\/+/, '').replace(/\\/g, '/');
  const abs = path.resolve(root, cleaned);
  const back = path.relative(root, abs);
  if (back.startsWith('..') || path.isAbsolute(back) || back === '') {
    throw new Error(`path "${rel}" is outside the workspace`);
  }
  return back.split(path.sep).join('/');
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
    const p = path.join(this.root, safeRel(this.root, rel));
    try {
      const st = await fs.stat(p);
      if (!st.isFile() || st.size > MAX_BYTES) return null;
      return await fs.readFile(p, 'utf8');
    } catch {
      return null;
    }
  }
  async writeFile(rel: string, text: string) {
    const p = path.join(this.root, safeRel(this.root, rel));
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
