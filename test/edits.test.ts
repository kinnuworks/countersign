import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, applySearchReplace, computeHunks } from '../src/core/edits';

const original = ['def a():', '    return 1', '', '', 'def b():', '    return 2', '', '', 'def c():', '    return 3', ''].join('\n');

test('search/replace applies exact and whitespace-tolerant blocks', () => {
  const r = applySearchReplace(original, [
    { old_text: '    return 1', new_text: '    return 10' },
    { old_text: 'def c():\nreturn 3', new_text: 'def c():\n    return 30' },
  ]);
  assert.equal(r.ok, true, r.errors.join());
  assert.match(r.text, /return 10/);
  assert.match(r.text, /return 30/);
});

test('ambiguous or missing old_text is refused with a reason the model can act on', () => {
  const twice = 'x = 1\nx = 1\n';
  assert.match(applySearchReplace(twice, [{ old_text: 'x = 1', new_text: 'x = 2' }]).errors[0], /matches 2 places/);
  assert.match(applySearchReplace(original, [{ old_text: 'nope', new_text: 'y' }]).errors[0], /not found/);
});

test('far-apart edits become separate hunks, and any subset applies cleanly', () => {
  const proposed = original.replace('return 1', 'return 10').replace('return 3', 'return 30');
  const hunks = computeHunks('f.py', original, proposed);
  assert.equal(hunks.length, 2);
  const onlyFirst = applyHunks(original, hunks, new Set([hunks[0].id]));
  assert.match(onlyFirst, /return 10/);
  assert.match(onlyFirst, /return 3\n/);
  const onlySecond = applyHunks(original, hunks, new Set([hunks[1].id]));
  assert.match(onlySecond, /return 1\n/);
  assert.match(onlySecond, /return 30/);
  assert.equal(applyHunks(original, hunks, new Set(hunks.map(h => h.id))), proposed);
  assert.equal(applyHunks(original, hunks, new Set()), original);
});

test('a new file is one hunk that recreates the content', () => {
  const hunks = computeHunks('n.py', '', 'a\nb\n');
  assert.equal(applyHunks('', hunks, new Set(hunks.map(h => h.id))).replace(/\n$/, ''), 'a\nb');
});
