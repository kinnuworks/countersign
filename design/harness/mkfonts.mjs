// Writes src/extension/panelFonts.ts: @font-face rules with the woff2 files inlined as data URIs,
// because the webview's CSP allows no network fonts. Usage: node design/harness/mkfonts.mjs <fontsdir> <family=file[:weights]>...
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, ...specs] = process.argv.slice(2);
const rules = specs.map(s => {
  const [family, rest] = s.split('=');
  const [file, weight = '100 900'] = rest.split(':');
  const b64 = readFileSync(join(dir, file)).toString('base64');
  return `@font-face{font-family:'${family}';font-style:normal;font-display:block;font-weight:${weight};src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
});
const names = [...new Set(specs.map(s => s.split('=')[0]))].join(', ');
writeFileSync('src/extension/panelFonts.ts', `// ${names}: SIL Open Font License 1.1, latin subsets from Fontsource. Inlined because the\n// panel's Content-Security-Policy allows no network fonts.\nexport const FONT_CSS = ${JSON.stringify(rules.join('\n'))};\n`);
console.log('wrote', names);
