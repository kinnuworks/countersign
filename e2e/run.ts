import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const root = path.resolve(__dirname, '..');
  const flask = process.argv[2];
  if (!flask) throw new Error('usage: node out/e2e-run.js <flask-checkout>');
  await runTests({
    version: 'stable',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out', 'e2e.js'),
    launchArgs: [flask, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: { ...process.env } as Record<string, string>,
  });
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
