/**
 * One-time TrueForge setup for Countersign: creates the model providers listed in
 * countersign.models.json (keys come from environment variables and are stored only in
 * TrueForge), saves both agent definitions, and checks the model chain.
 *
 *   node --env-file=.env.local out/setup.js            # providers + agents
 *   node out/setup.js --broken-endpoint                 # also add an unreachable provider for Task C
 *   node out/setup.js --break-key anthropic             # Task C variant: set an invalid key (restore with --restore)
 */
import * as path from 'node:path';
import { loadAgent, loadModelsConfig, provisionProviders } from '../src/core/config';
import { Forge } from '../src/core/forge';

async function main() {
  const root = path.resolve(__dirname, '..');
  const cfg = await loadModelsConfig(root);
  const base = cfg.trueforge.baseUrl;
  const forge = new Forge(base);
  if (!(await forge.health())) {
    console.error(`TrueForge is not answering at ${base}. Start it first:\n  OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest`);
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  if (argv.includes('--broken-endpoint') || (argv.includes('--break-endpoint') && !argv[argv.indexOf('--break-endpoint') + 1])) {
    const body = JSON.stringify({ manifest: { type: 'custom', name: 'broken-endpoint', base_url: 'http://127.0.0.1:9/v1', auth: { api_key: 'not-a-real-key' }, models: [{ model_id: 'unreachable', name: 'unreachable', properties: { context_length: 128000, max_output_tokens: 4096 } }] } });
    let r = await fetch(`${base}/api/v1/settings/model-providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (r.status === 409) r = await fetch(`${base}/api/v1/settings/model-providers`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
    console.log(r.ok ? 'ok broken-endpoint/unreachable (points at 127.0.0.1:9, nothing listens there)' : `FAILED ${r.status} ${await r.text()}`);
    return;
  }
  const brkEp = argv.indexOf('--break-endpoint');
  if (brkEp >= 0 && argv[brkEp + 1] && !argv[brkEp + 1].startsWith('--')) {
    // Task C, literally: TrueForge's own provider config points at an address nothing listens on.
    const target = argv[brkEp + 1];
    const p = cfg.providers.find(x => (x.manifest.name ?? x.manifest.type) === target);
    if (!p) throw new Error(`no provider ${target} in countersign.models.json`);
    await provisionProviders(base, { ...cfg, providers: [{ ...p, manifest: { ...p.manifest, base_url: 'http://127.0.0.1:9/v1' } }] }, process.env, console.log);
    console.log(`${target} in TrueForge now points at http://127.0.0.1:9/v1 (nothing listens there). Undo: npm run setup -- --restore ${target}`);
    return;
  }
  const breakIdx = argv.indexOf('--break-key');
  const restore = argv.includes('--restore');
  if (breakIdx >= 0 || restore) {
    const target = breakIdx >= 0 ? argv[breakIdx + 1] : argv[argv.indexOf('--restore') + 1];
    const p = cfg.providers.find(x => (x.manifest.name ?? x.manifest.type) === target);
    if (!p) throw new Error(`no provider ${target} in countersign.models.json`);
    const env = restore ? process.env : { ...process.env, [p.apiKeyEnv ?? 'X']: 'sk-invalid-key-for-task-c' };
    await provisionProviders(base, { ...cfg, providers: [{ ...p, apiKey: restore ? p.apiKey : 'sk-invalid-key-for-task-c', apiKeyEnv: p.apiKeyEnv }] }, env, console.log);
    console.log(restore ? `restored the ${target} key from the environment` : `${target} now has an invalid key`);
    return;
  }
  await provisionProviders(base, cfg, process.env, console.log);
  for (const n of ['countersign-coder', 'countersign-inline'] as const) {
    const def = await loadAgent(root, n);
    try {
      await forge.saveAgent({ ...def, spec: { ...def.spec, model: { ...def.spec.model, name: cfg.chain[0] } } });
      console.log(`ok agent ${n}`);
    } catch (e) {
      // MCP servers are registered by the extension at launch; until then TrueForge may refuse an agent that names them.
      console.log(`agent ${n} will be saved when the extension starts (${(e as Error).message.slice(0, 120)})`);
    }
  }
  const have = new Set((await forge.models()).map(m => m.name));
  for (const m of cfg.chain) console.log(`${have.has(m) ? 'ok' : 'MISSING'} chain model ${m}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
