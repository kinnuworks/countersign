// Direction sheets: the reference's first screen above our panel in each state (dark, then light).
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
const require = createRequire(homedir() + '/.claude/skills/hackathon-design/scripts/package.json');
const { chromium } = require('playwright');
const refs = { a: ['copilot', 'GitHub Copilot'], b: ['greptile', 'Greptile'], c: ['workflow', 'Workflow'] };
const out = 'design/directions'; mkdirSync(out, { recursive: true });
const H = resolve('design/harness/out'), R = resolve('design/refs');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1640, height: 1000 }, deviceScaleFactor: 1 });
for (const ids of (process.argv[2] ?? 'abc').split('')) {
  const [slug, name] = refs[ids];
  const cell = (f, cap) => `<figure><img src="file://${H}/${f}.png"><figcaption>${cap}</figcaption></figure>`;
  const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;padding:24px;background:#2a2a2a;color:#eee;font:15px -apple-system,sans-serif}h1{font-size:22px;margin:0 0 4px}p{margin:0 0 16px;color:#bbb}
  .ref{width:1592px;height:560px;object-fit:cover;object-position:top;display:block;border:1px solid #555}.row{display:flex;gap:18px;margin-top:22px}figure{margin:0}figure img{width:380px;display:block;border:1px solid #555}figcaption{margin-top:6px;color:#bbb}</style>
  <h1>Direction ${ids.toUpperCase()}: built on ${name}'s system</h1><p>Top: ${name}'s own first screen. Below: the Countersign panel in a VS Code sidebar (380 px), dark theme then light. Context card = real retriever output on flask 3.1.3; run messages are sample data.</p>
  <img class="ref" src="file://${R}/${slug}/hero-1440.png">
  <div class="row">${cell(`${ids}-dark-run`, 'Task B running: context, subagent, approval')}${cell(`${ids}-dark-review`, 'Task A: per-hunk review waiting')}${cell(`${ids}-dark-fallback`, 'Task C: retries, fallback, approved')}${cell(`${ids}-dark-cancel`, 'Stop: cancelled, git clean')}</div>
  <div class="row">${cell(`${ids}-light-review`, 'Light theme: review')}${cell(`${ids}-light-run`, 'Light theme: run')}${cell(`${ids}-dark-empty`, 'Empty (dark)')}${cell(`${ids}-dark-offline`, 'TrueForge not running (dark)')}</div>`;
  writeFileSync(`${out}/sheet-${ids}.html`, html);
  await p.goto('file://' + resolve(`${out}/sheet-${ids}.html`));
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/sheet-${ids}.png`, fullPage: true });
}
await b.close(); console.log('sheets done');
