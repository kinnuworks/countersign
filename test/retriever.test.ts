import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Retriever } from '../src/core/retriever';
import { NodeWorkspace } from '../src/core/workspace';

const flask = process.env.FLASK_DIR ?? path.resolve(__dirname, '..', '.ref', 'flask');
const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

test('Task B: code, its tests and its docs come first, within budget, each with a reason', { skip: !existsSync(flask) && 'no flask checkout' }, async () => {
  const r = new Retriever(new NodeWorkspace(flask));
  await r.build();
  const pack = r.retrieve(TASK_B, { budgetTokens: 10000 });
  const top = pack.files.slice(0, 3).map(f => f.path);
  assert.deepEqual(top, ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst']);
  assert.ok(pack.usedTokens <= pack.budgetTokens);
  for (const f of pack.files) assert.ok(f.reasons.length > 0);
  assert.ok(pack.omitted.length > 0, 'something was left out');
});

test('@-pinned files always come first', { skip: !existsSync(flask) && 'no flask checkout' }, async () => {
  const r = new Retriever(new NodeWorkspace(flask));
  await r.build();
  const pack = r.retrieve('anything at all', { pinned: ['src/flask/helpers.py'] });
  assert.equal(pack.files[0].path, 'src/flask/helpers.py');
  assert.deepEqual(r.findSymbol('get_debug_flag')[0], { file: 'src/flask/helpers.py', line: 28, kind: 'def', name: 'get_debug_flag' });
});
