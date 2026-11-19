import { Retriever } from '../../src/core/retriever';
import { NodeWorkspace } from '../../src/core/workspace';
const TASK_A = process.env.TA!, TASK_B = process.env.TB!;
(async () => {
  const ws = new NodeWorkspace(process.argv[2]);
  const r = new Retriever(ws as any);
  await r.build();
  const pack = r.retrieve(TASK_B, { budgetTokens: 10_000 });
  const out = {
    taskA: TASK_A, taskB: TASK_B,
    context: { type: 'context', by: 'auto', used: pack.usedTokens, budget: pack.budgetTokens, indexed: pack.indexedFiles,
      files: pack.files.map(f => ({ path: f.path, why: f.reasons.join('; '), tokens: f.tokens })),
      omitted: pack.omitted.length, omittedSample: pack.omitted.slice(0, 4).map(o => o.path) },
  };
  console.log(JSON.stringify(out, null, 1));
})();
