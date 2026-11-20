import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Workspace } from './workspace';
import { gitStatus, isForbidden, run, safeRel } from './workspace';
import type { Retriever, ContextPack } from './retriever';
import type { ChangeJournal } from './journal';
import { normalizeEdits } from './edits';

export const EDITOR_SERVER = 'countersign-editor';
export const EXTRAS_SERVER = 'countersign-extras';
/** Tools that change the workspace or run code. TrueForge pauses before each one for approval. */
export const GATED_TOOLS = ['propose_edit', 'create_file', 'run_command'];

/** What the user decided in the review for one gated tool call. */
export type Decision =
  | { kind: 'write'; path: string; finalText: string; before: string | null; accepted: number; total: number; rejectedNotes: string[] }
  | { kind: 'run'; command: string };

/**
 * Matches TrueForge's approved tool call to the review the user did for it. The MCP request does
 * not carry TrueForge's tool-call id, so decisions are keyed by tool name and canonical arguments.
 */
export class ApprovalBook {
  private pending = new Map<string, Decision[]>();

  /** Only the fields each tool's schema keeps, since the MCP layer drops anything else the model sent. */
  static key(tool: string, args: unknown): string {
    const fields: Record<string, string[]> = {
      propose_edit: ['path', 'edits', 'explanation'],
      create_file: ['path', 'content', 'explanation'],
      run_command: ['command', 'explanation'],
    };
    let a: unknown = args;
    if (typeof a === 'string') {
      try {
        a = JSON.parse(a);
      } catch {
        /* keep as is */
      }
    }
    if (a && typeof a === 'object' && fields[tool]) {
      const o = a as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const f of fields[tool]) if (o[f] !== undefined) picked[f] = f === 'edits' ? normalizeEdits(o[f]) : o[f];
      a = picked;
    }
    return `${tool}:${canonical(a)}`;
  }

  record(tool: string, args: unknown, d: Decision) {
    const k = ApprovalBook.key(tool, args);
    this.pending.set(k, [...(this.pending.get(k) ?? []), d]);
  }

  take(tool: string, args: unknown): Decision | undefined {
    const k = ApprovalBook.key(tool, args);
    const list = this.pending.get(k);
    if (list?.length) {
      const d = list.shift()!;
      if (!list.length) this.pending.delete(k);
      return d;
    }
    // Fall back to the only pending write for the same path, in case the harness re-serialised arguments.
    const path = typeof (args as { path?: unknown })?.path === 'string' ? (args as { path: string }).path : undefined;
    if (path) {
      const hits = [...this.pending.entries()].filter(([key, ds]) => key.startsWith(`${tool}:`) && ds.some(d => d.kind === 'write' && d.path === path));
      if (hits.length === 1) {
        const [key, ds] = hits[0];
        const d = ds.shift()!;
        if (!ds.length) this.pending.delete(key);
        return d;
      }
    }
    return undefined;
  }

  clear() {
    this.pending.clear();
  }
}

/** Stable key text for tool arguments. Only a top-level string is parsed as JSON (whole-arguments strings). */
export function canonical(v: unknown, top = true): string {
  if (typeof v === 'string') {
    if (top) {
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === 'object') return canonical(parsed, false);
      } catch {
        /* plain string */
      }
    }
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(x => canonical(x, false)).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k], false)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export interface ToolActivity {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface ToolHost {
  ws: Workspace;
  retriever: Retriever;
  book: ApprovalBook;
  journal: ChangeJournal;
  /** Called after every write so the host can refresh editors and the index. */
  afterWrite?(path: string, text: string): Promise<void> | void;
  onActivity?(a: ToolActivity): void;
  onContext?(pack: ContextPack, by: 'agent'): void;
  commandTimeoutMs?: number;
  /** Prepended to PATH for approved commands only (a project virtualenv). */
  commandPathPrefix?: string;
}

/** Approved commands get a small environment: no API keys, tokens or secrets from the editor's own. */
export function commandEnv(prefix?: string): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TERM|TMPDIR|TZ|PYTHONPATH|VIRTUAL_ENV|NODE_ENV)$/;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (keep.test(k) && !/KEY|TOKEN|SECRET|PASSWORD/i.test(k)) env[k] = v;
  if (prefix) env.PATH = `${prefix}:${env.PATH ?? ''}`;
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  return env;
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

function numbered(lines: string[], from: number): string {
  return lines.map((l, i) => `${String(from + i).padStart(5)}| ${l}`).join('\n');
}

/** Running commands, so a cancel can kill them and leave nothing behind. */
const liveChildren = new Set<import('node:child_process').ChildProcess>();
export function killRunningCommands() {
  for (const c of liveChildren) {
    try {
      if (c.pid) process.kill(-c.pid, 'SIGTERM');
    } catch {
      c.kill('SIGTERM');
    }
  }
  liveChildren.clear();
}

function runShell(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(command, { cwd, shell: true, detached: true, env });
    liveChildren.add(child);
    let out = '';
    const cap = (b: Buffer) => {
      out += b.toString();
      if (out.length > 60_000) out = out.slice(0, 20_000) + '\n...[output trimmed]...\n' + out.slice(-30_000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve({ code, output: out, timedOut });
    });
  });
}

function editorServer(host: ToolHost): McpServer {
  const s = new McpServer({ name: EDITOR_SERVER, version: '0.1.0' });
  const act = (tool: string, args: Record<string, unknown>, summary: string) => host.onActivity?.({ tool, args, summary });

  s.registerTool(
    'retrieve_context',
    {
      description:
        "Countersign's retriever: ranks the repository's code, tests and docs for a task and returns the best files with WHY each was chosen, their outlines and the most relevant line ranges, cut at a token budget. Call it first, then read_file for anything you need in full.",
      inputSchema: { query: z.string().describe('the task or question, in plain words'), budget_tokens: z.number().int().min(1000).max(30000).optional() },
      annotations: { readOnlyHint: true, title: 'Retrieve context' },
    },
    async ({ query, budget_tokens }) => {
      const pack = host.retriever.retrieve(query, { budgetTokens: budget_tokens ?? 8000 });
      host.onContext?.(pack, 'agent');
      act('retrieve_context', { query }, `${pack.files.length} files, ${pack.usedTokens}/${pack.budgetTokens} tokens`);
      return text(pack.text);
    },
  );

  s.registerTool(
    'read_file',
    {
      description: 'Read a workspace file (current editor text, including unsaved changes) with line numbers. Use start_line/end_line for big files.',
      inputSchema: { path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() },
      annotations: { readOnlyHint: true, title: 'Read file' },
    },
    async ({ path, start_line, end_line }) => {
      const rel = safeRel(host.ws.root, path);
      const t = await host.ws.readFile(rel);
      if (t == null) return text(`No such file (or too large): ${rel}`);
      const lines = t.split(/\r?\n/);
      const from = Math.max(1, start_line ?? 1);
      const to = Math.min(lines.length, end_line ?? Math.min(lines.length, from + 599));
      act('read_file', { path: rel }, `${rel}:${from}-${to}`);
      const more = to < lines.length ? `\n[showing lines ${from}-${to} of ${lines.length}; ask for more with start_line]` : '';
      return text(`${rel} (${lines.length} lines)\n${numbered(lines.slice(from - 1, to), from)}${more}`);
    },
  );

  s.registerTool(
    'list_files',
    {
      description: 'List workspace files under a directory (respects .gitignore).',
      inputSchema: { dir: z.string().optional().describe('directory relative to the workspace root; empty for all') },
      annotations: { readOnlyHint: true, title: 'List files' },
    },
    async ({ dir }) => {
      const all = await host.ws.listFiles();
      const prefix = dir ? safeRel(host.ws.root, dir).replace(/\/?$/, '/') : '';
      const hits = all.filter(f => f.startsWith(prefix));
      act('list_files', { dir: dir ?? '' }, `${hits.length} files`);
      return text(hits.slice(0, 400).join('\n') + (hits.length > 400 ? `\n... ${hits.length - 400} more` : ''));
    },
  );

  s.registerTool(
    'search_code',
    {
      description: 'Search the workspace for a regular expression (git grep, case-insensitive by default). Returns file:line: text, up to 80 matches.',
      inputSchema: { pattern: z.string(), path_glob: z.string().optional().describe('e.g. "src/**/*.py"'), case_sensitive: z.boolean().optional() },
      annotations: { readOnlyHint: true, title: 'Search code' },
    },
    async ({ pattern, path_glob, case_sensitive }) => {
      let lines: string[];
      try {
        lines = await searchCode(host.ws.root, pattern, path_glob, case_sensitive);
      } catch (e) {
        return text(`search failed: ${(e as Error).message}`);
      }
      act('search_code', { pattern }, `${lines.length} matches`);
      return text(lines.slice(0, 80).map(l => (l.length > 240 ? l.slice(0, 240) + '...' : l)).join('\n') + (lines.length > 80 ? `\n... ${lines.length - 80} more` : '') || 'no matches');
    },
  );

  s.registerTool(
    'find_symbol',
    {
      description: 'Find where a function, method or class is defined (by name, exact or partial).',
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true, title: 'Find symbol' },
    },
    async ({ name }) => {
      const hits = host.retriever.findSymbol(name);
      act('find_symbol', { name }, `${hits.length} definitions`);
      return text(hits.length ? hits.map(h => `${h.file}:${h.line} ${h.kind} ${h.name}`).join('\n') : `no definition named like "${name}"`);
    },
  );

  s.registerTool(
    'repo_map',
    {
      description: 'A compact map of the repository: each file with its functions and classes, most relevant to the query first, within a token budget.',
      inputSchema: { query: z.string().optional(), budget_tokens: z.number().int().min(500).max(12000).optional() },
      annotations: { readOnlyHint: true, title: 'Repo map' },
    },
    async ({ query, budget_tokens }) => {
      act('repo_map', { query: query ?? '' }, 'symbol map');
      return text(host.retriever.repoMap(query, budget_tokens ?? 3000));
    },
  );

  s.registerTool(
    'propose_edit',
    {
      description:
        'Propose changes to ONE existing file as exact search/replace blocks. old_text must be copied exactly from the current file (enough lines to be unique); new_text replaces it. The user reviews every hunk before anything is written; the result tells you which hunks were applied or rejected. Put all changes for a file in one call; call it once per file (several files may be proposed in parallel).',
      inputSchema: {
        path: z.string(),
        // Some models send the array as a JSON string; accept both and normalise.
        edits: z.union([z.array(z.object({ old_text: z.string(), new_text: z.string() })).min(1), z.string()]),
        explanation: z.string().describe('one sentence: what this change does and why'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, title: 'Propose edit (reviewed)' },
    },
    async args => applyDecision(host, 'propose_edit', args),
  );

  s.registerTool(
    'create_file',
    {
      description: 'Propose a NEW file with its full content. The user reviews it before it is written.',
      inputSchema: { path: z.string(), content: z.string(), explanation: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, title: 'Create file (reviewed)' },
    },
    async args => applyDecision(host, 'create_file', args),
  );

  s.registerTool(
    'run_command',
    {
      description: 'Run a shell command in the workspace root (for example the test suite) after the user approves it. Returns exit code and output.',
      inputSchema: { command: z.string(), explanation: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, title: 'Run command (approved)' },
    },
    async args => {
      const d = host.book.take('run_command', args);
      if (!d || d.kind !== 'run') return text('Not run: no approval was recorded for this exact command.');
      act('run_command', { command: args.command }, 'running');
      const r = await runShell(args.command, host.ws.root, host.commandTimeoutMs ?? 180_000, commandEnv(host.commandPathPrefix));
      act('run_command', { command: args.command }, `exit ${r.code}${r.timedOut ? ' (timed out)' : ''}`);
      return text(`$ ${args.command}\nexit code: ${r.code}${r.timedOut ? ' (killed after timeout)' : ''}\n${r.output.slice(-12000)}`);
    },
  );
  return s;
}

export async function applyDecision(host: ToolHost, tool: 'propose_edit' | 'create_file', args: Record<string, unknown>) {
  const d = host.book.take(tool, args);
  if (!d || d.kind !== 'write') {
    return text('Nothing was written: this call has no reviewed approval on record. Propose the change again.');
  }
  const rel = safeRel(host.ws.root, d.path);
  const current = await host.ws.readFile(rel);
  if (current !== d.before && !(current == null && d.before == null)) {
    return text(`Nothing was written: ${rel} changed while the review was open. Read it again and re-propose.`);
  }
  await host.ws.writeFile(rel, d.finalText);
  host.journal.record(`${tool === 'create_file' ? 'create' : 'edit'} ${rel}`, [{ path: rel, before: d.before, after: d.finalText }]);
  host.retriever.update(rel, d.finalText);
  await host.afterWrite?.(rel, d.finalText);
  host.onActivity?.({ tool, args: { path: rel }, summary: `wrote ${d.accepted}/${d.total} hunks` });
  const rejected = d.rejectedNotes.length ? `\nRejected by the user: ${d.rejectedNotes.join('; ')}. Do not re-apply rejected hunks unless asked.` : '';
  return text(`Applied ${d.accepted} of ${d.total} hunks to ${rel}.${rejected}`);
}

function extrasServer(host: ToolHost): McpServer {
  const s = new McpServer({ name: EXTRAS_SERVER, version: '0.1.0' });
  s.registerTool(
    'git_status',
    { description: 'Show git status (porcelain) of the workspace.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => text((await gitStatus(host.ws.root)) || 'clean'),
  );
  s.registerTool(
    'git_diff',
    { description: 'Show the uncommitted diff of the workspace, optionally for one path.', inputSchema: { path: z.string().optional() }, annotations: { readOnlyHint: true } },
    async ({ path }) => {
      const r = await run('git', ['diff', '--', ...(path ? [safeRel(host.ws.root, path)] : [])], host.ws.root);
      return text(r.stdout.slice(0, 20000) || 'no changes');
    },
  );
  s.registerTool(
    'applied_changes',
    { description: 'List the change sets the user has accepted in this editor session (newest last), with their files.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () =>
      text(
        host.journal
          .all()
          .map(c => `${c.id} ${c.undone ? '(undone) ' : ''}${c.label}: ${c.files.map(f => f.path).join(', ')}`)
          .join('\n') || 'none yet',
      ),
  );
  return s;
}

export interface ToolServer {
  port: number;
  token: string;
  url(server: string): string;
  close(): Promise<void>;
}

/** Serves both MCP servers on 127.0.0.1 with a per-launch bearer token. */
/**
 * git grep over tracked and untracked (not ignored) files, as file:line: text. Lines from git
 * internals and secret env files are dropped, the same rule read_file applies.
 */
export async function searchCode(root: string, pattern: string, pathGlob?: string, caseSensitive?: boolean): Promise<string[]> {
  const args = ['grep', '-n', '-I', '-E', '--untracked'];
  if (!caseSensitive) args.push('-i');
  args.push('-e', pattern, '--');
  if (pathGlob) args.push(`:(glob)${pathGlob}`);
  const r = await run('git', args, root);
  if (r.code > 1) throw new Error(r.stderr.trim());
  return r.stdout.split('\n').filter(l => {
    const m = /^(.*?):\d+:/.exec(l);
    return l && !(m && isForbidden(m[1]));
  });
}

export async function startToolServer(host: ToolHost, port = 0): Promise<ToolServer> {
  const token = randomBytes(24).toString('hex');
  const srv = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? '';
      const which = url.startsWith(`/mcp/${EDITOR_SERVER}`) ? 'editor' : url.startsWith(`/mcp/${EXTRAS_SERVER}`) ? 'extras' : null;
      if (!which) {
        res.writeHead(404).end();
        return;
      }
      const got = Buffer.from(String(req.headers.authorization ?? ''));
      const want = Buffer.from(`Bearer ${token}`);
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      let body = '';
      for await (const c of req) {
        body += c;
        if (body.length > 5_000_000) {
          res.writeHead(413).end('too large');
          return;
        }
      }
      const server = which === 'editor' ? editorServer(host) : extrasServer(host);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end('internal error');
    }
  });
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve());
  });
  const addr = srv.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  return {
    port: actual,
    token,
    url: (server: string) => `http://127.0.0.1:${actual}/mcp/${server}`,
    close: () =>
      new Promise<void>(r => {
        // TrueForge keeps MCP connections alive; drop them so shutdown does not hang.
        srv.close(() => r());
        srv.closeAllConnections();
      }),
  };
}
