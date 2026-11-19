// Screenshots every harness page at sidebar size (scrolled to the bottom, like the live panel).
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
const require = createRequire(homedir() + '/.claude/skills/hackathon-design/scripts/package.json');
const { chromium } = require('playwright');
const dir = process.argv[2] ?? 'design/harness/out';
const only = process.argv[3];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: Number(process.env.W || 380), height: 860 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
for (const f of readdirSync(dir).filter(f => f.endsWith('.html') && (!only || f.includes(only)))) {
  await p.goto('file://' + resolve(dir, f));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(150);

  await p.screenshot({ path: `${dir}/${f.replace('.html', '.png')}` });
  await p.screenshot({ path: `${dir}/${f.replace('.html', '-full.png')}`, fullPage: true });
}
await b.close();
console.log(errs.length ? 'ERRORS:\n' + [...new Set(errs)].join('\n') : 'no script errors');
