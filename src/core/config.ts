import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AgentDefinition, RetryPolicy } from './forge';

export interface ProviderEntry {
  manifest: Record<string, unknown> & { type: string; name?: string };
  /** Environment variable holding the key; read only at setup time. */
  apiKeyEnv?: string;
  /** A literal key for local endpoints that need none (Ollama). */
  apiKey?: string;
  optional?: boolean;
}

export interface ModelsConfig {
  trueforge: { baseUrl: string };
  /** Fallback order: the first model runs, the next takes over when it fails. */
  chain: string[];
  retry: RetryPolicy;
  providers: ProviderEntry[];
}

export async function loadModelsConfig(dir: string): Promise<ModelsConfig> {
  for (const name of ['countersign.models.json', 'countersign.models.example.json']) {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as ModelsConfig;
    } catch {
      /* try the next */
    }
  }
  throw new Error(`No countersign.models.json in ${dir}`);
}

export async function loadAgent(dir: string, name: 'countersign-coder' | 'countersign-inline'): Promise<AgentDefinition> {
  return JSON.parse(await fs.readFile(path.join(dir, 'agent', `${name}.json`), 'utf8')) as AgentDefinition;
}

/** Creates or updates each model provider in TrueForge (keys go to TrueForge, never to disk here). */
export async function provisionProviders(baseUrl: string, cfg: ModelsConfig, env: NodeJS.ProcessEnv, log: (s: string) => void) {
  for (const p of cfg.providers) {
    const key = p.apiKey ?? (p.apiKeyEnv ? env[p.apiKeyEnv] : undefined);
    const label = p.manifest.name ?? p.manifest.type;
    if (!key) {
      log(`${p.optional ? 'skip' : 'MISSING'} ${label}: set ${p.apiKeyEnv} to configure it`);
      continue;
    }
    const manifest = { ...p.manifest, auth: { api_key: key } };
    const send = (method: string) => fetch(`${baseUrl}/api/v1/settings/model-providers`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }) });
    let r = await send('POST');
    if (r.status === 409) r = await send('PUT');
    const body = await r.text();
    log(r.ok ? `ok ${label}: ${(p.manifest.models as { name: string }[]).map(m => `${p.manifest.name ?? p.manifest.type}/${m.name}`).join(', ')}` : `FAILED ${label}: ${r.status} ${body.slice(0, 200)}`);
  }
}
