/**
 * Headless runner for the three fixed tasks on pallets/flask 3.1.3, against a real local
 * TrueForge and real models. The only thing it replaces is the human reviewer: it accepts
 * (or rejects, when asked) hunks through the same approval path the editor uses.
 *
 *   node out/harness.js --repo /tmp/flask --task B [--chain a,b] [--reject first] [--cancel-after-ms 4000] [--json out.json]
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Countersign } from '../src/core/countersign';
import { loadAgent, loadModelsConfig } from '../src/core/config';
import type { ApprovalAnswer, RunObserver, ToolCallInfo } from '../src/core/forge';
import { proposalFromCall, recordCommand, recordReview } from '../src/core/proposals';
import { NodeWorkspace, run } from '../src/core/workspace';

export const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
export const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function main() {
  const repo = path.resolve(arg('repo') ?? '');
  const task = (arg('task') ?? 'B').toUpperCase();
  const root = path.resolve(__dirname, '..');
  const cfg = await loadModelsConfig(root);
  const chain = arg('chain')?.split(',') ?? cfg.chain;
  const reject = arg('reject'); // "first": reject the first hunk of the first file
  const cancelAfter = arg('cancel-after-ms') ? Number(arg('cancel-after-ms')) : undefined;
  const jsonOut = arg('json');

  const ws = new NodeWorkspace(repo);
  const cs = new Countersign(ws, { coder: await loadAgent(root, 'countersign-coder'), inline: await loadAgent(root, 'countersign-inline') }, chain, cfg.retry, cfg.trueforge.baseUrl, {
    onActivity: a => log(`  tool ${a.tool}`, JSON.stringify(a.args).slice(0, 120), '->', a.summary),
    onContext: (p, by) => log(`context (${by}): ${p.files.length} files, ${p.usedTokens}/${p.budgetTokens} tokens:`, p.files.map(f => f.path).join(', ')),
  });
  await cs.start();
  const summary: Record<string, unknown> = { task, chain, repo, statuses: [] as string[], threads: [] as string[], approvals: [] as string[] };
  let rejectedOne = false;
  let deltas = 0;
  const observer: RunObserver = {
    onStatus: (t, k) => {
      log(`status[${k}] ${t}`);
      (summary.statuses as string[]).push(`${k}: ${t}`);
    },
    onSession: s => {
      log(`session ${s.sessionId} model=${s.model} ${s.url}`);
      summary.session = s;
    },
    onDelta: (_t, text) => {
      deltas++;
      if (process.env.CS_STREAM) process.stdout.write(text);
    },
    onThread: t => {
      log(`thread ${t.done ? 'done' : 'created'} ${t.threadId} ${t.title}`);
      if (!t.done) (summary.threads as string[]).push(t.title);
    },
    onApprovals: async (calls: ToolCallInfo[]) => {
      const answers: ApprovalAnswer[] = [];
      for (const c of calls) {
        if (c.name === 'run_command') {
          recordCommand(cs.book, c);
          (summary.approvals as string[]).push(`run: ${String(c.args.command)}`);
          answers.push({ toolCallId: c.id, threadId: c.threadId, allow: true });
          continue;
        }
        const r = await proposalFromCall(ws, c);
        if (!r.ok) {
          log(`  deny ${c.name}: ${r.reason}`);
          answers.push({ toolCallId: c.id, threadId: c.threadId, allow: false, reason: r.reason });
          continue;
        }
        const accepted = new Set(r.p.file.hunks.map(h => h.id));
        if (reject === 'first' && !rejectedOne && r.p.file.hunks.length > 1) {
          accepted.delete(r.p.file.hunks[0].id);
          rejectedOne = true;
        }
        log(`  review ${r.p.file.path}: ${r.p.file.hunks.length} hunks, accepting ${accepted.size}`);
        (summary.approvals as string[]).push(`${r.p.file.path}: ${accepted.size}/${r.p.file.hunks.length}`);
        const d = recordReview(cs.book, r.p, accepted);
        answers.push({ toolCallId: c.id, threadId: c.threadId, allow: d.allow, reason: d.reason });
      }
      return answers;
    },
  };

  const ac = new AbortController();
  let cancelledAt: number | undefined;
  if (cancelAfter) {
    setTimeout(() => {
      cancelledAt = Date.now();
      log('cancelling (as the user pressing Stop)');
      ac.abort();
    }, cancelAfter);
  }
  const before = await cs.gitStatus();
  const t0 = Date.now();
  let result;
  if (task === 'A' || task === 'C') {
    const hits = cs.retriever.findSymbol('get_debug_flag').filter(h => h.file === 'src/flask/helpers.py');
    if (!hits.length) throw new Error('get_debug_flag not found');
    const text = (await ws.readFile('src/flask/helpers.py'))!.split('\n');
    let end = hits[0].line;
    while (end < text.length && !/^(def|class|@)\b/.test(text[end] ?? '')) end++;
    while (end > hits[0].line && !text[end - 1].trim()) end--;
    log(`inline selection src/flask/helpers.py:${hits[0].line}-${end}`);
    result = await cs.runInline({ path: 'src/flask/helpers.py', startLine: hits[0].line, endLine: end, instruction: TASK_A }, observer, ac.signal);
  } else {
    result = await cs.runAgent(TASK_B, observer, ac.signal);
    summary.pack = { used: result.pack.usedTokens, budget: result.pack.budgetTokens, files: result.pack.files.map(f => ({ path: f.path, why: f.reasons })) };
  }
  const ms = Date.now() - t0;
  const after = await cs.gitStatus();
  Object.assign(summary, {
    status: result.status,
    model: result.model,
    attempts: result.attempts,
    error: result.error,
    ms,
    deltas,
    output: result.output.slice(0, 2000),
    gitBefore: before,
    gitAfter: after,
    cancelLatencyMs: cancelledAt ? Date.now() - cancelledAt : undefined,
    journal: cs.journal.all().map(c => ({ label: c.label, files: c.files.map(f => f.path) })),
  });
  log(`result ${result.status} model=${result.model} in ${(ms / 1000).toFixed(1)}s; git status:\n${after || '(clean)'}`);
  await cs.stop();
  if (jsonOut) await fs.writeFile(jsonOut, JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

export { run };
