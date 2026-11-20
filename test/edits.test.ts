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
  assert.equal(applyHunks('', hunks, new Set(hunks.map(h => h.id))), 'a\nb\n');
});

test('a docstring edit and a code edit two lines apart are separate hunks', () => {
  const orig = ['def f():', '    """Doc.', '    """', '    v = 1', '    return v in {0}', ''].join('\n');
  const prop = ['def f():', '    """Doc.', '    More doc.', '    """', '    v = 1', '    return v in {0, 1}', ''].join('\n');
  const hunks = computeHunks('f.py', orig, prop);
  assert.equal(hunks.length, 2);
  assert.equal(applyHunks(orig, hunks, new Set([hunks[0].id])), ['def f():', '    """Doc.', '    More doc.', '    """', '    v = 1', '    return v in {0}', ''].join('\n'));
  assert.equal(applyHunks(orig, hunks, new Set([hunks[1].id])), ['def f():', '    """Doc.', '    """', '    v = 1', '    return v in {0, 1}', ''].join('\n'));
  assert.equal(applyHunks(orig, hunks, new Set(hunks.map(h => h.id))), prop);
});

test('CRLF files stay CRLF through search/replace and partial acceptance', () => {
  const orig = ['one', 'two', 'three', 'four', 'five', 'six', ''].join('\r\n');
  const r = applySearchReplace(orig, [{ old_text: 'one', new_text: 'ONE' }, { old_text: 'six', new_text: 'SIX' }]);
  assert.equal(r.ok, true);
  const hunks = computeHunks('w.txt', orig, r.text);
  assert.equal(hunks.length, 2);
  assert.equal(applyHunks(orig, hunks, new Set([hunks[0].id])), ['ONE', 'two', 'three', 'four', 'five', 'six', ''].join('\r\n'));
  const multi = applySearchReplace(orig, [{ old_text: 'two\nthree', new_text: 'TWO\nTHREE' }]);
  assert.equal(multi.ok, true);
  assert.ok(!/[^\r]\n/.test(multi.text), 'no bare LF in a CRLF file');
});

test('a new file keeps its final newline', () => {
  const hunks = computeHunks('n.py', '', 'x\ny\n');
  assert.equal(applyHunks('', hunks, new Set(hunks.map(h => h.id))), 'x\ny\n');
});

test('a change to the end-of-file newline survives partial acceptance', () => {
  // Adding a final newline: accepting only that hunk adds it; accepting nothing leaves it off.
  const noNl = 'a\nb\nc\nd\ne\nf';
  const addNl = 'A\nb\nc\nd\ne\nf\n';
  const hs = computeHunks('x.txt', noNl, addNl);
  assert.equal(hs.length, 2);
  assert.equal(applyHunks(noNl, hs, new Set([hs[1].id])), 'a\nb\nc\nd\ne\nf\n');
  assert.equal(applyHunks(noNl, hs, new Set([hs[0].id])), 'A\nb\nc\nd\ne\nf');
  assert.equal(applyHunks(noNl, hs, new Set(hs.map(h => h.id))), addNl);
  assert.equal(applyHunks(noNl, hs, new Set()), noNl);
  // The smallest case, and the reverse (removing the final newline), in LF and CRLF.
  const one = computeHunks('y.txt', 'a\nb', 'a\nb\n');
  assert.equal(applyHunks('a\nb', one, new Set(one.map(h => h.id))), 'a\nb\n');
  const rm = computeHunks('z.txt', 'a\nb\n', 'a\nb');
  assert.equal(applyHunks('a\nb\n', rm, new Set(rm.map(h => h.id))), 'a\nb');
  const crlf = computeHunks('w.txt', 'a\r\nb', 'a\r\nb\r\n');
  assert.equal(applyHunks('a\r\nb', crlf, new Set(crlf.map(h => h.id))), 'a\r\nb\r\n');
  // A new file written without a final newline keeps it that way.
  const fresh = computeHunks('n.txt', '', 'x\ny');
  assert.equal(applyHunks('', fresh, new Set(fresh.map(h => h.id))), 'x\ny');
});
