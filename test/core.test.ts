import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBook } from '../src/core/tools';
import { classifyError } from '../src/core/forge';
import { ChangeJournal } from '../src/core/journal';
import { NodeWorkspace, safeRel, type Workspace } from '../src/core/workspace';
import { commandEnv } from '../src/core/tools';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

class MemWs implements Workspace {
  root = '/mem';
  files = new Map<string, string>();
  async listFiles() { return [...this.files.keys()]; }
  async readFile(p: string) { return this.files.get(p) ?? null; }
  async writeFile(p: string, t: string) { this.files.set(p, t); }
  async deleteFile(p: string) { this.files.delete(p); }
}

test('approval book matches the MCP call to the reviewed decision, ignoring extra or reordered fields', () => {
  const b = new ApprovalBook();
  const args = { path: 'a.py', edits: [{ old_text: 'x', new_text: 'y' }], explanation: 'e' };
  b.record('propose_edit', JSON.stringify({ ...args, extra: 1 }), { kind: 'write', path: 'a.py', finalText: 'y', before: 'x', accepted: 1, total: 1, rejectedNotes: [] });
  const d = b.take('propose_edit', { explanation: 'e', edits: [{ new_text: 'y', old_text: 'x' }], path: 'a.py' });
  assert.equal(d?.kind, 'write');
  assert.equal(b.take('propose_edit', args), undefined, 'a decision is used once');
});

test('an unreviewed write finds no decision', () => {
  assert.equal(new ApprovalBook().take('propose_edit', { path: 'a.py', edits: [], explanation: '' }), undefined);
});

test('model errors are classified for retry and fallback', () => {
  assert.deepEqual(classifyError('[Model Error] Cannot connect to API: bad port'), { cls: 'network', retry: true, fallback: true });
  assert.equal(classifyError('[Model Error] 401 invalid x-api-key').cls, 'auth');
  assert.equal(classifyError('[Model Error] 401 invalid x-api-key').retry, false);
  assert.equal(classifyError('429 rate limit exceeded').retry, true);
  assert.equal(classifyError('503 Service Unavailable').cls, 'server');
  assert.equal(classifyError('some tool bug').fallback, false);
});

test('undo restores exactly, and refuses when the file changed after the edit', async () => {
  const ws = new MemWs();
  ws.files.set('a.py', 'old');
  const j = new ChangeJournal();
  await ws.writeFile('a.py', 'new');
  j.record('edit a.py', [{ path: 'a.py', before: 'old', after: 'new' }]);
  await ws.writeFile('b.py', 'created');
  j.record('create b.py', [{ path: 'b.py', before: null, after: 'created' }]);
  assert.equal((await j.undo(ws)).ok, true);
  assert.equal(ws.files.has('b.py'), false);
  ws.files.set('a.py', 'edited by hand');
  assert.equal((await j.undo(ws)).ok, false);
  ws.files.set('a.py', 'new');
  assert.equal((await j.undo(ws)).ok, true);
  assert.equal(ws.files.get('a.py'), 'old');
});

test('paths: no escape, no git internals or secret env files, no symlink way out', async () => {
  assert.throws(() => safeRel('/r', '../x'));
  assert.throws(() => safeRel('/r', '.git/config'));
  assert.throws(() => safeRel('/r', 'a/.env'));
  assert.throws(() => safeRel('/r', '.env.production'));
  assert.equal(safeRel('/r', '.env.example'), '.env.example');
  assert.throws(() => safeRel('/r', 'a"b.py'));
  const root = mkdtempSync(path.join(tmpdir(), 'cs-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'cs-out-'));
  writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  symlinkSync(outside, path.join(root, 'link'));
  mkdirSync(path.join(root, 'src'));
  const ws = new NodeWorkspace(root);
  assert.equal(await ws.readFile('link/secret.txt'), null);
  await assert.rejects(ws.writeFile('link/new.txt', 'x'));
  await ws.writeFile('src/ok.py', 'x = 1\n');
  assert.equal(await ws.readFile('src/ok.py'), 'x = 1\n');
});

test('approved commands do not inherit API keys or tokens', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.GITHUB_TOKEN = 't';
  const env = commandEnv('/w/.venv/bin');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.match(env.PATH ?? '', /^\/w\/\.venv\/bin:/);
});

test('edits sent as a JSON string match the same approval as an array', () => {
  const b = new ApprovalBook();
  const edits = [{ old_text: 'a', new_text: 'b' }];
  b.record('propose_edit', { path: 'x.py', edits: JSON.stringify(edits), explanation: 'e' }, { kind: 'write', path: 'x.py', finalText: 'b', before: 'a', accepted: 1, total: 1, rejectedNotes: [] });
  assert.equal(b.take('propose_edit', { path: 'x.py', edits, explanation: 'e' })?.kind, 'write');
});
