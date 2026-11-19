import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// The panel's HTML and script live in a template string; a lost escape there breaks the whole
// webview silently (the extension still activates). Evaluate the template and parse the script.
test('the agent panel webview script parses', () => {
  const src = readFileSync(path.resolve(__dirname, '..', 'src', 'extension', 'panel.ts'), 'utf8');
  const start = src.indexOf('return /* html */ `');
  const end = src.lastIndexOf('</html>`');
  assert.ok(start > 0 && end > start, 'html template not found');
  const body = src.slice(start + 'return /* html */ '.length, end + '</html>`'.length);
  // eslint-disable-next-line no-eval
  const html: string = eval(body.replace(/\$\{[^}]+\}/g, 'X'));
  const js = html.slice(html.indexOf('<script nonce='), html.lastIndexOf('</script>')).replace(/^<script[^>]*>/, '');
  assert.doesNotThrow(() => new Function(js));
  assert.match(js, /postMessage\(\{ type: 'ready' \}\)/);
});
