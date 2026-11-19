import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: true, logLevel: 'warning' };
await build({ ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'out/extension.js', external: ['vscode'] });
await build({ ...common, entryPoints: ['harness/tasks.ts'], outfile: 'out/harness.js' });
await build({ ...common, entryPoints: ['scripts/setup.ts'], outfile: 'out/setup.js' });
const tests = readdirSync('test').filter(f => f.endsWith('.test.ts')).map(f => `test/${f}`);
if (tests.length) await build({ ...common, entryPoints: tests, outdir: 'out-test' });
