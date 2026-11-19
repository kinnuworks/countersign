// docs/writeup.md -> docs/writeup.pdf (A4, 1-3 pages) via headless Chrome.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { marked } from 'marked';

const md = readFileSync('docs/writeup.md', 'utf8');
if (/\{\{[A-Z_]+\}\}/.test(md) && !process.argv.includes('--draft')) {
  console.error('writeup.md still has {{placeholders}}; pass --draft to build anyway');
  process.exit(1);
}
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 13mm 14mm; }
body { font: 9.6pt/1.38 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; }
h1 { font-size: 15pt; margin: 0 0 4pt; }
h2 { font-size: 11pt; margin: 9pt 0 3pt; border-bottom: 0.6pt solid #bbb; padding-bottom: 1pt; }
p, li { margin: 2pt 0; }
ul { padding-left: 13pt; margin: 2pt 0; }
code { font: 8.6pt Menlo, monospace; background: #f2f2f2; padding: 0 2pt; border-radius: 2pt; }
table { border-collapse: collapse; width: 100%; font-size: 8.4pt; margin: 3pt 0; }
th, td { border: 0.5pt solid #bbb; padding: 2pt 4pt; vertical-align: top; text-align: left; }
th { background: #f0f0f0; }
a { color: #0645ad; text-decoration: none; }
</style></head><body>${marked.parse(md)}</body></html>`;
writeFileSync('docs/writeup.html', html);
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${process.cwd()}/docs/writeup.pdf`, `file://${process.cwd()}/docs/writeup.html`], { stdio: 'ignore' });
const pages = (readFileSync('docs/writeup.pdf', 'latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`docs/writeup.pdf: ${pages} page(s)`);
if (pages > 3) process.exit(2);
