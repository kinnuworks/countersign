import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Forge, type AgentDefinition, type RetryPolicy, type RunObserver, type RunResult, type ToolCallInfo } from './forge';
import { ChangeJournal } from './journal';
import { Retriever, type ContextPack } from './retriever';
import { ApprovalBook, applyDecision, startToolServer, type ToolActivity, type ToolServer } from './tools';
import { gitStatus, type Workspace } from './workspace';

export interface InlineRequest {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  instruction: string;
}

export interface CountersignEvents {
  onActivity?(a: ToolActivity): void;
  onContext?(pack: ContextPack, by: 'auto' | 'agent'): void;
  afterWrite?(path: string, text: string): Promise<void> | void;
}

/**
 * Everything both front ends share: the workspace, the retriever, the journal, the MCP tool
 * server registered in TrueForge, and the two agents. The VS Code extension and the headless
 * harness differ only in how they review approvals.
 */
export class Countersign {
  readonly retriever: Retriever;
  readonly journal = new ChangeJournal();
  readonly book = new ApprovalBook();
  readonly forge: Forge;
  tools?: ToolServer;

  constructor(
    readonly ws: Workspace,
    readonly agents: { coder: AgentDefinition; inline: AgentDefinition },
    public chain: string[],
    public retry: RetryPolicy,
    baseUrl: string,
    readonly events: CountersignEvents = {},
  ) {
    this.retriever = new Retriever(ws);
    this.forge = new Forge(baseUrl);
  }

  async start(): Promise<void> {
    await this.retriever.build();
    const venvBin = path.join(this.ws.root, '.venv', 'bin');
    if (existsSync(venvBin) && !(process.env.PATH ?? '').split(path.delimiter).includes(venvBin)) {
      // Commands the agent runs use the project's own virtualenv when it has one.
      process.env.PATH = `${venvBin}${path.delimiter}${process.env.PATH ?? ''}`;
    }
    this.tools = await startToolServer({
      ws: this.ws,
      retriever: this.retriever,
      book: this.book,
      journal: this.journal,
      afterWrite: (p, t) => this.events.afterWrite?.(p, t),
      onActivity: a => this.events.onActivity?.(a),
      onContext: pack => this.events.onContext?.(pack, 'agent'),
    });
    await this.forge.registerToolServers(this.tools);
    for (const def of [this.agents.coder, this.agents.inline]) {
      try {
        await this.forge.saveAgent({ ...def, spec: { ...def.spec, model: { ...def.spec.model, name: this.chain[0] ?? def.spec.model.name } } });
      } catch {
        // Saving to the registry only makes the agent visible in TrueForge's Agents page; runs use the inline spec.
      }
    }
  }

  async stop() {
    await this.tools?.close();
  }

  /** Agent mode: automatic retrieval first, then the coder agent with the context pack. */
  async runAgent(request: string, observer: RunObserver, signal: AbortSignal, opts: { pinned?: string[]; open?: string[]; budgetTokens?: number } = {}): Promise<RunResult & { pack: ContextPack }> {
    const pack = this.retriever.retrieve(request, { budgetTokens: opts.budgetTokens ?? 10_000, pinned: opts.pinned, open: opts.open });
    this.events.onContext?.(pack, 'auto');
    const input = `${pack.text}\n\n---\nTask (from the user): ${request}`;
    const result = await this.forge.run({ agent: this.agents.coder, models: this.chain, input, title: `Countersign agent: ${request.slice(0, 60)}`, observer, signal, retry: this.retry });
    return { ...result, pack };
  }

  /** Inline edit: the selection plus its surroundings go to the inline agent, which proposes one reviewed edit. */
  async runInline(req: InlineRequest, observer: RunObserver, signal: AbortSignal): Promise<RunResult & { usedFallbackParse: boolean }> {
    const text = (await this.ws.readFile(req.path)) ?? '';
    const lines = text.split(/\r?\n/);
    const s = Math.max(1, req.startLine);
    const e = Math.min(lines.length, req.endLine);
    const num = (from: number, to: number) =>
      lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}| ${l}`)
        .join('\n');
    const before = num(Math.max(1, s - 25), s - 1);
    const after = num(e + 1, Math.min(lines.length, e + 15));
    const symbols = this.retriever
      .findSymbol(lines.slice(s - 1, e).join(' ').match(/\bdef\s+(\w+)/)?.[1] ?? '__none__')
      .slice(0, 3)
      .map(h => `${h.file}:${h.line} ${h.name}`)
      .join('\n');
    const input = [
      `File: ${req.path}`,
      `Selected lines ${s}-${e}:`,
      '<<<SELECTION',
      num(s, e),
      'SELECTION>>>',
      before ? `Code before the selection:\n${before}` : '',
      after ? `Code after the selection:\n${after}` : '',
      symbols ? `Where the selected symbol is defined:\n${symbols}` : '',
      `Instruction: ${req.instruction}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    let sawEditCall = false;
    const wrapped: RunObserver = {
      ...observer,
      onApprovals: async (calls, sig) => {
        if (calls.some(c => c.name === 'propose_edit')) sawEditCall = true;
        return observer.onApprovals(calls, sig);
      },
      onToolCall: c => {
        if (c.name === 'propose_edit') sawEditCall = true;
        observer.onToolCall?.(c);
      },
    };
    const result = await this.forge.run({ agent: this.agents.inline, models: this.chain, input, title: `Countersign inline: ${req.instruction.slice(0, 60)}`, observer: wrapped, signal, retry: this.retry });
    if (result.status !== 'done' || sawEditCall) return { ...result, usedFallbackParse: false };

    // A model that cannot call tools may answer with the rewritten selection in a fenced block.
    const m = /```[\w-]*\n([\s\S]*?)```/.exec(result.output);
    if (!m) return { ...result, usedFallbackParse: false };
    const selection = lines.slice(s - 1, e).join('\n');
    const call: ToolCallInfo = {
      id: 'local-fallback',
      threadId: 'main',
      name: 'propose_edit',
      args: { path: req.path, edits: [{ old_text: selection, new_text: m[1].replace(/\n$/, '') }], explanation: 'rewritten selection (model replied in text)' },
      rawArgs: '',
    };
    observer.onStatus?.('The model replied with text instead of a tool call; showing its rewrite for review.', 'info');
    const [answer] = await observer.onApprovals([call], signal);
    if (answer?.allow) {
      await applyDecision({ ws: this.ws, retriever: this.retriever, book: this.book, journal: this.journal, afterWrite: (p, t) => this.events.afterWrite?.(p, t) }, 'propose_edit', call.args);
    }
    return { ...result, usedFallbackParse: true, wrote: !!answer?.allow };
  }

  async undo(id?: string) {
    const r = await this.journal.undo(this.ws, id);
    if (r.ok && r.set) for (const f of r.set.files) this.retriever.update(f.path, f.before);
    return r;
  }

  gitStatus() {
    return gitStatus(this.ws.root);
  }
}
