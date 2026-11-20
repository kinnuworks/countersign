# Countersign: a VS Code coding agent on TrueForge

## 1. Team

Team Kinnu (Techfest Team ID TM-732F269AC17). Dhiraj Kavuri (team leader, sole member), GitHub @kinnuworks.

## 2. Starting point

From scratch. No upstream editor project was forked. Libraries: `@truefoundry/trueforge-sdk` 0.185 (sessions, streamed turns, approvals, cancel), `@modelcontextprotocol/sdk` (the editor's MCP servers), `diff` (jsdiff, hunk computation), `zod` (tool schemas). Repository: https://github.com/kinnuworks/countersign (MIT).

## 3. Architecture on TrueForge

The extension is a client of a local TrueForge (`npx @truefoundry/trueforge@latest`). It never calls a model provider.

- **Agent definitions** live in the repo (`agent/countersign-coder.json`, `agent/countersign-inline.json`). The extension saves them in TrueForge's agent registry at startup. Each run creates a session with that spec and the current model from the fallback chain.
- **Loop and streaming.** `sessions.createTurnStream` runs the turn. `model.message.delta` events render as they arrive, including tool-call arguments, so an edit is visible while the model writes it. Subagent `thread.*` events show as their own cards. Stop calls `sessions.cancel`.
- **Editor capabilities as MCP tools.** The extension hosts two MCP servers on 127.0.0.1 (streamable HTTP, a bearer token per launch passed through TrueForge's header auth). TrueForge needs `OUTBOUND_URL_ALLOWED_HOSTS` set for loopback, which is its own documented setting.
  - `countersign-editor` (preloaded): `retrieve_context`, `read_file`, `list_files`, `search_code`, `find_symbol`, `repo_map`, `propose_edit`, `create_file`, `run_command`. Reads see unsaved buffer text.
  - `countersign-extras` (`preload: false`): `git_status`, `git_diff`, `applied_changes`. The agent discovers these through TrueForge's deferred-loading meta tools.
- **Approval drives the review.** `propose_edit`, `create_file` and `run_command` are listed in `require_approval_for_tools`, so TrueForge pauses the turn (`tool.approval_required`). The extension then:
  1. turns the call's search/replace blocks into hunks and opens them in the diff editor, with CodeLens Accept/Reject per hunk and the same controls in the panel;
  2. records the accepted subset against the call's arguments, and answers with `user.tool_approval` (allow, or deny with a reason that names the rejected hunks);
  3. lets TrueForge execute the approved MCP call, whose handler writes exactly the recorded subset through `WorkspaceEdit`, journals it for undo, and re-indexes the file. The tool result tells the model which hunks were applied and which were rejected.
- **Harness features used, and why.**
  - Subagents: a `context-scout` explores before any edit and returns files, line ranges and the pattern to follow, which keeps raw search output out of the main context.
  - Deferred tool loading: the extras server stays out of the prompt until it is needed.
  - Compaction: set at 60k input tokens for long runs.
  - Tool approvals: the diff review.
  - Streaming events and cancel.
- **Trade-off.** Writes land per approved call, not as one transaction at the end of the run. The model sees the real file state and the user's rejections right away. Each approved set can be undone, and a cancelled run cannot leave a partial file, because a file is written only inside one complete approved call.

## 4. How context is selected

Retrieval runs before the first model call and as a tool the agent can call again (`src/core/retriever.ts`).

- **Index.** Files are split into symbol-sized chunks: Python functions and classes (with decorators), doc sections, line windows elsewhere.
- **Ranking.** BM25 over chunks, plus four rules:
  - drop query words present in more than a quarter of all chunks (the project's own name);
  - weight each file by how much of the request it covers, with rare words counting more;
  - when the request asks for tests or docs, reserve the first slots for the best code, test and doc file, preferring tests that import the chosen module and docs with the same stem;
  - lift files along the import graph from the top modules.
- **Budget.** 10,000 estimated tokens by default (setting `countersign.contextBudget`). Each chosen file gets its outline, the reason it was chosen, and its best line ranges. Files that did not fit are listed as left out. `@file` and `@symbol` mentions are pinned first.
- **On screen.** In Task B the panel's Context card shows the budget bar and each file with its reason. The agent can ask for more with `retrieve_context` (its own budget), `search_code`, `find_symbol` and `repo_map`.
- **Measured.** Back-test on public data (pallets/flask history, 2021-2026). The plan was committed before the run. On the held-out slice (79 commits, 2023 to 3.1.3), every edited file landed in the pack for 21 commits, against 11 for BM25 over whole files as used in SWE-bench at the same budget. The paired difference is +0.127 (95% interval 0.025 to 0.228). Ranking alone is level with BM25 (recall in the top 5: 0.424 vs 0.441); the gain comes from packing symbol chunks instead of whole files. Rerun: `node out/replay.js`.

## 5. Model setup

| Model (TrueForge name) | Where it ran | Role | Measured use per run (TrueForge turn metrics) | Approx. cost per run |
|---|---|---|---|---|
| Claude Sonnet 5.5 (`anthropic/claude-sonnet-5-5`) | Anthropic API, configured in TrueForge's catalog provider | first in the chain; used in the video | Task B: ~220k input tokens (~165k cache reads, ~55k cache writes), ~9k output. Task A: ~7k input, ~1k output | Task B ~$0.24, Task A ~$0.014 |
| Claude Haiku 5.5 (`anthropic-openai/claude-haiku-5-5`) | Anthropic's OpenAI-compatible endpoint, registered in TrueForge as a custom provider | fallback (Task C) | Task A: ~5k input, ~1k output | under $0.001 |
| Claude Haiku 5.5 (`anthropic/claude-haiku-5-5`) | Anthropic API | tested (model matrix) | Task B: ~153k input (mostly cache), ~6k output | ~$0.01 |
| gemma4 e4b (`ollama/gemma4-e4b`) | local, Ollama behind an OpenAI-compatible endpoint | tested (model matrix): too slow on our Mac, failed Task A | n/a | $0 |
| `broken-endpoint/unreachable` | 127.0.0.1:9 (nothing listens) | Task C test provider | n/a | $0 |

Prices used: Sonnet 5.5 $2 / $10 per million input / output tokens, $0.10 cache reads; Haiku 5.5 $0.10 / $0.50; cache writes priced at about 1.25 times input. Everything we ran through TrueForge by 03:00 IST on 20 November, development included (42 sessions), comes to under $2 at these prices.

Switching models: TrueForge Settings → Models (or `npm run setup` from `countersign.models.json`, keys read from the environment and stored only in TrueForge), then the `countersign.models` setting, which is the fallback order. Network, rate-limit and server errors retry the same model with exponential backoff (2 retries, 0.8 s then 1.6 s), then the next model takes over. Auth errors skip the retries. The extension works with any model TrueForge can serve. For models that cannot call tools, inline edit accepts a fenced code block and still routes it through the same review.

## 6. Scorecard

Timestamps refer to the demo video, https://youtu.be/1mb-7CJMMH8 (3:18).

| Criterion | Video | Claim |
|---|---|---|
| A1 Inline edit | 0:05 | `Cmd+Alt+K` on `get_debug_flag`; the diff opens with ✓/✗ on each of its 2 hunks (CodeLens and panel); verified `False` |
| A2 Agent mode | 0:32 | one request, no files named; the agent found and edited `cli.py`, `test_cli.py`, `docs/cli.rst` (+ changelog/API docs) |
| A3 Streaming and cancellation | 3:03 | tokens and drafts stream live; Stop (Esc) cancels the TrueForge turn at once; `git status` clean |
| B1 Context assembly | 0:39 | Context card: 10k-token budget bar, each chosen file with its reason, files left out; context-scout subagent |
| B2 Diff safety | 0:27 | per-hunk accept/reject; "Undo last change" restores the file, `git status` clean |
| B3 Resilience | 2:32 | TrueForge's Anthropic provider pointed at a dead address: 2 retries with backoff, then automatic fallback; no files changed before accept |
| B4 TrueForge depth | 2:20 | TrueForge's session view for Task B: 1 turn, 24 tool calls, 1 sub-agent, approval pauses on the timeline; MCP editor tools; approvals drive the review |
| C1 Video | 0:00-3:18 | Tasks A, B, C in order, each verified in the terminal on screen |
| C2 Write-up | this document | architecture, context strategy and its measured result, model costs, trade-offs, limitations |

## 7. Tools used

Claude Code (Anthropic's coding agent) wrote most of the code, tests and documentation under the team's direction. VS Code 1.147 and its extension test runner, TrueForge 0.185 in local mode, Ollama for the local model, uv for Flask's locked test environment, ffmpeg and a small ScreenCaptureKit recorder for the video.

## 8. Known limitations and another month

- **Per-call writes.** An agent run applies each approved call as it comes, so a run that edits five files gives five change sets in undo history, not one. A later version would group a run's approvals into one review and one undo step.
- **Retrieval is lexical and structural, with no embeddings.** It knows Python structure best; other languages are chunked by line windows. On real Flask history, its ranking alone is only level with BM25. The gain comes from packing chunks, and commit messages are a weak stand-in for real requests.
- **Small local models.** gemma4 e4b on Ollama was too slow on our machine for the fallback role, so the shipped chain falls back to a second provider instead (Anthropic's OpenAI-compatible endpoint).
- **Loopback MCP needs one TrueForge setting** (`OUTBOUND_URL_ALLOWED_HOSTS`). TrueForge must run on Node 22 or 24, because on Node 26 its bundled HTTP client crashes.
- **Rejected hunks are not re-proposed automatically.** The model is told exactly what was rejected and can ask again.

With another month:
- embeddings next to BM25, with the same replay as the guard;
- one review per run, with a single undo for the whole run;
- language servers (go-to-definition and references) as MCP tools, so retrieval follows real symbols in every language;
- skills for repository conventions;
- a TrueForge pull request adding a fallback model list to the agent spec, so fallback moves into the harness.
