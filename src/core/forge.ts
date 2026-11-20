import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { EDITOR_SERVER, EXTRAS_SERVER, killRunningCommands, type ToolServer } from './tools';

/** The agent definition shipped in the repo (agent/*.json); the model is swapped per fallback step. */
export interface AgentDefinition {
  name: string;
  description: string;
  spec: Record<string, unknown> & { model: { name: string; params?: Record<string, unknown> }; instructions: string };
}

export interface ToolCallInfo {
  id: string;
  threadId: string;
  name: string;
  server?: string;
  args: Record<string, unknown>;
  rawArgs: string;
}

export interface ApprovalAnswer {
  toolCallId: string;
  threadId: string;
  allow: boolean;
  reason?: string;
}

export type StatusKind = 'info' | 'warn' | 'error' | 'ok';

/** Everything the UI (or the headless harness) hears from a run. */
export interface RunObserver {
  onStatus?(text: string, kind: StatusKind): void;
  onSession?(info: { sessionId: string; model: string; url: string }): void;
  onDelta?(threadId: string, text: string): void;
  onReasoning?(threadId: string, text: string): void;
  onToolCall?(call: ToolCallInfo): void;
  /** A tool call's arguments as the model writes them, so drafts stream before the call completes. */
  onToolDraft?(threadId: string, name: string, argsSoFar: string): void;
  onToolResult?(call: ToolCallInfo | undefined, content: string): void;
  onThread?(t: { threadId: string; title: string; instructions?: string; done?: boolean; status?: string }): void;
  /** Must resolve with one answer per call. Record review decisions before allowing writes. */
  onApprovals(calls: ToolCallInfo[], signal: AbortSignal): Promise<ApprovalAnswer[]>;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RunResult {
  usage?: Usage;
  status: 'done' | 'cancelled' | 'error';
  output: string;
  model?: string;
  sessionId?: string;
  error?: string;
  attempts: { model: string; outcome: string; ms: number }[];
  wrote: boolean;
}

export interface RetryPolicy {
  /** Retries of the same model for transient failures (network, 5xx, 429, timeouts). */
  retries: number;
  baseDelayMs: number;
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export type ErrorClass = 'network' | 'auth' | 'rate' | 'server' | 'context' | 'model' | 'other';

/** Sorts TrueForge's "[Model Error] ..." messages into what to do next. */
export function classifyError(message: string): { cls: ErrorClass; retry: boolean; fallback: boolean } {
  const m = message.toLowerCase();
  if (/(401|403|invalid.*(api[_ -]?key|x-api-key|token)|authentication|unauthori[sz]ed|permission|forbidden|incorrect api key)/.test(m)) return { cls: 'auth', retry: false, fallback: true };
  if (/(cannot connect|econnrefused|enotfound|getaddrinfo|bad port|network|fetch failed|socket|timed? ?out|etimedout|econnreset|unreachable)/.test(m)) return { cls: 'network', retry: true, fallback: true };
  if (/(429|rate.?limit|overloaded|too many requests|quota)/.test(m)) return { cls: 'rate', retry: true, fallback: true };
  if (/(500|502|503|504|529|internal server error|bad gateway|service unavailable)/.test(m)) return { cls: 'server', retry: true, fallback: true };
  if (/(context length|context window|too long|maximum context|prompt is too long)/.test(m)) return { cls: 'context', retry: false, fallback: true };
  if (/model error|not found|unknown model|does not exist/.test(m)) return { cls: 'model', retry: false, fallback: true };
  return { cls: 'other', retry: false, fallback: false };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Cancelled());
    });
  });

type AnyEvent = { type: string; id: string; threadId?: string | null; [k: string]: unknown };

export class Forge {
  readonly client: TrueForge;
  constructor(readonly baseUrl: string) {
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: 900 });
  }

  sessionUrl(sessionId: string) {
    // TrueForge's session inspector: turns, tool calls, sub-agents and approvals on one timeline.
    return `${this.baseUrl.replace(/\/$/, '')}/sessions?view=sessions&sessionId=${encodeURIComponent(sessionId)}`;
  }

  private async api(method: string, path: string, body?: unknown) {
    const r = await fetch(this.baseUrl + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let json: unknown = undefined;
    try {
      json = JSON.parse(t);
    } catch {
      /* not json */
    }
    return { status: r.status, json: json as { data?: unknown; error?: { message?: string } } | undefined, text: t };
  }

  async health(): Promise<boolean> {
    try {
      const r = await fetch(this.baseUrl + '/healthz');
      return r.ok;
    } catch {
      return false;
    }
  }

  async models(): Promise<{ name: string; context_length?: number }[]> {
    const r = await this.api('GET', '/api/v1/models');
    const data = (r.json?.data ?? []) as { name: string; properties?: { context_length?: number } }[];
    return data.map(d => ({ name: d.name, context_length: d.properties?.context_length }));
  }

  /** Registers (or re-points) both MCP servers at this launch's port and token. */
  async registerToolServers(ts: ToolServer): Promise<void> {
    for (const [name, description] of [
      [EDITOR_SERVER, 'Countersign editor tools: retrieve context, read and search the workspace, propose reviewed edits, run approved commands.'],
      [EXTRAS_SERVER, 'Countersign extras: git status, git diff, and the change sets the user accepted. Loaded on demand.'],
    ] as const) {
      const manifest = { type: 'remote', name, description, url: ts.url(name), auth: { type: 'header', headers: { Authorization: `Bearer ${ts.token}` } } };
      let r = await this.api('POST', '/api/v1/settings/mcp-servers', { manifest });
      if (r.status === 409) r = await this.api('PUT', '/api/v1/settings/mcp-servers', { manifest });
      if (r.status >= 300) {
        const msg = r.json?.error?.message ?? r.text;
        if (/outbound url blocked/i.test(msg)) {
          throw new Error(`TrueForge blocks loopback MCP servers by default. Start it with OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' (see README). (${msg})`);
        }
        throw new Error(`Could not register ${name} in TrueForge: ${msg}`);
      }
    }
  }

  /** Saves the agent definition in TrueForge's registry, so it shows under Agents with its tools and approvals. */
  async saveAgent(def: AgentDefinition): Promise<void> {
    const list = await this.api('GET', '/api/v1/agents');
    const items = ((list.json?.data as { items?: unknown[] } | unknown[] | undefined) ?? []) as unknown;
    const arr = (Array.isArray(items) ? items : ((items as { items?: unknown[] }).items ?? [])) as { id: string; name: string }[];
    const existing = arr.find(a => a.name === def.name);
    const r = existing
      ? await this.api('PUT', `/api/v1/agents/${existing.id}`, { description: def.description, manifest: def.spec })
      : await this.api('POST', '/api/v1/agents', { name: def.name, description: def.description, manifest: def.spec });
    if (r.status >= 300) throw new Error(`Could not save agent ${def.name}: ${r.json?.error?.message ?? r.text}`);
  }

  /**
   * Runs one request through the model chain. Transient failures are retried on the same model
   * with exponential backoff; then the next configured model takes over with no user action.
   * A fallback never happens after a write, so a retried request cannot apply an edit twice.
   */
  async run(opts: {
    agent: AgentDefinition;
    models: string[];
    input: string;
    title: string;
    observer: RunObserver;
    signal: AbortSignal;
    retry?: RetryPolicy;
  }): Promise<RunResult> {
    const { observer, signal } = opts;
    const retry = opts.retry ?? { retries: 2, baseDelayMs: 800 };
    const attempts: RunResult['attempts'] = [];
    const models = opts.models.length ? opts.models : [opts.agent.spec.model.name];
    let lastError = '';
    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      for (let attempt = 0; attempt <= retry.retries; attempt++) {
        if (signal.aborted) return { status: 'cancelled', output: '', attempts, wrote: false };
        const t0 = Date.now();
        const r = await this.runOnce({ ...opts, model });
        attempts.push({ model, outcome: r.status === 'error' ? `error: ${r.error}` : r.status, ms: Date.now() - t0 });
        if (r.status !== 'error') return { ...r, attempts };
        lastError = r.error ?? 'unknown error';
        const c = classifyError(lastError);
        if (r.wrote) {
          observer.onStatus?.(`Model failed after changes were applied (${lastError}). Stopping so nothing is applied twice.`, 'error');
          return { ...r, attempts };
        }
        if (c.retry && attempt < retry.retries) {
          const delay = retry.baseDelayMs * 2 ** attempt;
          observer.onStatus?.(`${model}: ${c.cls} error (${lastError}). Retry ${attempt + 1}/${retry.retries} in ${(delay / 1000).toFixed(1)}s.`, 'warn');
          try {
            await sleep(delay, signal);
          } catch {
            return { status: 'cancelled', output: '', attempts, wrote: false };
          }
          continue;
        }
        if (!c.fallback) {
          observer.onStatus?.(`${model} failed: ${lastError}`, 'error');
          return { ...r, attempts };
        }
        if (mi + 1 < models.length) observer.onStatus?.(`${model} unavailable (${c.cls}: ${lastError}). Switching to fallback model ${models[mi + 1]}.`, 'warn');
        break;
      }
    }
    observer.onStatus?.(`Every configured model failed. Last error: ${lastError}. Nothing was changed.`, 'error');
    return { status: 'error', output: '', error: lastError, attempts, wrote: false };
  }

  private async runOnce(opts: { agent: AgentDefinition; model: string; input: string; title: string; observer: RunObserver; signal: AbortSignal }): Promise<Omit<RunResult, 'attempts'>> {
    const { observer, signal } = opts;
    const spec = { ...opts.agent.spec, model: { ...opts.agent.spec.model, name: opts.model } };
    let sessionId: string | undefined;
    let wrote = false;
    try {
      const { data: session } = await this.client.sessions.create({ agent: { spec } as never, metadata: { title: opts.title } as never });
      sessionId = session.id;
      observer.onSession?.({ sessionId: session.id, model: opts.model, url: this.sessionUrl(session.id) });
    } catch (e) {
      const body = (e as { body?: { error?: { message?: string } } }).body?.error?.message;
      return { status: 'error', output: '', error: `[Model Error] TrueForge refused a session for ${opts.model}: ${body ?? (e as Error).message}`, wrote };
    }
    const sid = sessionId;
    const onAbort = () => {
      killRunningCommands();
      void this.client.sessions.cancel(sid).catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort);

    const events = new Map<string, AnyEvent>();
    const calls = new Map<string, ToolCallInfo>();
    let turnId: string | undefined;
    let lastEventId: string | undefined;
    let pending: { id: string; sourceEventId: string; threadId: string }[] = [];
    let usage: Usage | undefined;

    const callFromMessage = (msgId: string, callId: string, threadId: string): ToolCallInfo | undefined => {
      const msg = events.get(msgId) as { toolCalls?: { id: string; function?: { name?: string; arguments?: string }; toolInfo?: { name?: string; serverName?: string } }[] } | undefined;
      const tc = msg?.toolCalls?.find(t => t.id === callId);
      if (!tc) return undefined;
      const rawArgs = tc.function?.arguments ?? '';
      const info: ToolCallInfo = { id: tc.id, threadId, name: tc.toolInfo?.name ?? tc.function?.name ?? 'tool', server: tc.toolInfo?.serverName, args: parseArgs(rawArgs), rawArgs };
      calls.set(tc.id, info);
      return info;
    };
    const findCall = (callId: string): ToolCallInfo | undefined => {
      if (calls.has(callId)) return calls.get(callId);
      for (const [id, ev] of events) {
        if (ev.type === 'model.message') {
          const hit = callFromMessage(id, callId, (ev.threadId as string) ?? 'main');
          if (hit) return hit;
        }
      }
      return undefined;
    };

    const consume = async (stream: AsyncIterable<AnyEvent>): Promise<{ paused: boolean; done?: Omit<RunResult, 'attempts'> }> => {
      for await (const ev of stream) {
        lastEventId = ev.id;
        const thread = (ev.threadId as string) ?? 'main';
        if (ev.type === 'turn.created') turnId = ev.turnId as string;
        if (isEventDelta(ev as never)) {
          const base = events.get(ev.id);
          if (base) {
            mergeEventDelta(base as never, ev as never);
            const tcs = (base as { toolCalls?: { function?: { name?: string; arguments?: string } }[] }).toolCalls;
            if (tcs?.length && (ev as { toolCalls?: unknown[] }).toolCalls) {
              const last = tcs[tcs.length - 1];
              observer.onToolDraft?.(thread, last.function?.name ?? 'tool', last.function?.arguments ?? '');
            }
          }
          const content = (ev as { content?: string }).content;
          if (content) observer.onDelta?.(thread, content);
          const reasoning = (ev as { reasoningContent?: string }).reasoningContent;
          if (reasoning) observer.onReasoning?.(thread, reasoning);
          continue;
        }
        events.set(ev.id, ev);
        switch (ev.type) {
          case 'tool.response': {
            const call = findCall(ev.toolCallId as string);
            if (call && ['propose_edit', 'create_file'].includes(call.name) && /^Applied /.test(String(ev.content ?? ''))) wrote = true;
            if (call) observer.onToolCall?.(call);
            observer.onToolResult?.(call, String(ev.content ?? ''));
            break;
          }
          case 'thread.created': {
            const info = ev.agentInfo as { input?: string } | undefined;
            observer.onThread?.({ threadId: ev.threadId as string, title: String(ev.title ?? 'subagent'), instructions: info?.input });
            break;
          }
          case 'thread.done': {
            const st = ev.state as { status?: string } | undefined;
            observer.onThread?.({ threadId: ev.threadId as string, title: '', done: true, status: st?.status });
            break;
          }
          case 'tool.approval_required': {
            for (const tc of (ev.toolCalls as { id: string; sourceEventId: string }[]) ?? []) pending.push({ ...tc, threadId: thread });
            break;
          }
          case 'turn.update': {
            const st = ev.state as { status?: string };
            if (st?.status === 'paused') return { paused: true };
            break;
          }
          case 'turn.done': {
            const st = ev.state as { status: string; output?: { content?: string }; message?: string; metrics?: Record<string, number> };
            const mt = st.metrics;
            if (mt) usage = { input: mt.totalInputTokens ?? 0, output: mt.totalOutputTokens ?? 0, cacheRead: mt.totalCacheReadTokens ?? 0, cacheWrite: mt.totalCacheWriteTokens ?? 0 };
            if (st.status === 'done') return { paused: false, done: { status: 'done', output: st.output?.content ?? '', sessionId: sid, model: opts.model, wrote, usage } };
            if (st.status === 'cancelled') return { paused: false, done: { status: 'cancelled', output: '', sessionId: sid, model: opts.model, wrote } };
            return { paused: false, done: { status: 'error', output: '', error: st.message ?? 'turn failed', sessionId: sid, model: opts.model, wrote } };
          }
        }
      }
      return { paused: false, done: { status: signal.aborted ? 'cancelled' : 'error', output: '', error: 'stream ended without turn.done', sessionId: sid, model: opts.model, wrote } };
    };

    try {
      const first = await this.client.sessions.createTurnStream(sid, { input: [{ type: 'user.message', content: opts.input }] } as never, { abortSignal: undefined } as never);
      let res = await consume(first as unknown as AsyncIterable<AnyEvent>);
      while (res.paused) {
        if (!turnId) throw new Error('paused turn without a turn id');
        const batch = pending;
        pending = [];
        const infos = batch.map(p => callFromMessage(p.sourceEventId, p.id, p.threadId) ?? { id: p.id, threadId: p.threadId, name: 'tool', args: {}, rawArgs: '' });
        let answers: ApprovalAnswer[];
        try {
          answers = await observer.onApprovals(infos, signal);
        } catch (e) {
          if (signal.aborted || e instanceof Cancelled) {
            onAbort();
            return { status: 'cancelled', output: '', sessionId: sid, model: opts.model, wrote };
          }
          throw e;
        }
        if (signal.aborted) return { status: 'cancelled', output: '', sessionId: sid, model: opts.model, wrote };
        const resume = await this.client.sessions.subscribeToTurn(sid, turnId, { afterEventId: lastEventId } as never, { timeoutInSeconds: 900 } as never);
        await this.client.sessions.createTurnEvents(sid, turnId, {
          events: answers.map(a => ({
            type: 'user.tool_approval',
            threadId: a.threadId,
            toolCallId: a.toolCallId,
            approval: a.allow ? { status: 'allow' } : { status: 'deny', reason: a.reason ?? 'rejected by the user' },
          })),
        } as never);
        res = await consume(resume as unknown as AsyncIterable<AnyEvent>);
      }
      return res.done!;
    } catch (e) {
      if (signal.aborted) return { status: 'cancelled', output: '', sessionId: sid, model: opts.model, wrote };
      return { status: 'error', output: '', error: (e as Error).message, sessionId: sid, model: opts.model, wrote };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
