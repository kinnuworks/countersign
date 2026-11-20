# Code tour

This tour follows one request through the code, in the order it runs. File sizes are small on purpose: about 3,700 lines in `src/` plus the evidence replay.

## 1. Start-up: `src/extension/extension.ts`

`activate()` registers the commands (`Cmd+Alt+K` inline edit, agent panel, Stop, Undo, Open TrueForge session) and builds one `Countersign` instance per workspace. `ensure()` loads the model chain from `countersign.models.json` (`src/core/config.ts`), saves both agent definitions from `agent/` into TrueForge's registry, and starts the editor's MCP servers.

## 2. The editor as MCP tools: `src/core/tools.ts`

`startToolServer()` serves two MCP servers on 127.0.0.1 with a bearer token per launch:

- `countersign-editor` (preloaded): `retrieve_context`, `read_file`, `list_files`, `search_code`, `find_symbol`, `repo_map`, `propose_edit`, `create_file`, `run_command`.
- `countersign-extras` (`preload: false`): `git_status`, `git_diff`, `applied_changes`. The agent finds these through TrueForge's deferred tool loading.

Reads go through `Workspace` (`src/extension/vscodeWorkspace.ts` in the editor, `NodeWorkspace` in `src/core/workspace.ts` headless), so the agent sees unsaved buffer text. Every path passes `safeRel()` and `assertInside()`: no `..`, no `.git`, no `.env`, no symlink way out, whatever the case of the name.

## 3. Context before the first model call: `src/core/retriever.ts`

`Retriever` splits the repository into symbol-sized chunks and ranks them with BM25, then adds four rules: drop words found everywhere, reward files that cover more of the request, reserve a slot for the best code, test and doc file (preferring tests that import the chosen code), and follow the import graph. It packs the best chunks into a 10,000-token budget with each file's outline and the reason it was chosen, and lists what it left out. That list is the Context card in the panel. `evidence/replay.ts` measures this against whole-file BM25 on 79 held-out Flask commits.

## 4. The loop runs on TrueForge: `src/core/forge.ts`

`Forge.run()` walks the model chain. Each attempt is `runOnce()`: create a session with the agent spec and the current model, then `sessions.createTurnStream`. Deltas stream into the panel as they arrive, including tool-call arguments, so an edit shows while it is being written. Subagent `thread.*` events show as their own cards.

`classifyError()` decides what a failure means: network, rate-limit and server errors retry the same model with backoff (0.8 s, then 1.6 s); auth, model and context errors skip straight to the next model. If anything was written before a failure, the run stops instead of switching models, so nothing is applied twice. Stop calls `sessions.cancel` and aborts the stream.

## 5. Approval drives the review: `src/core/proposals.ts`, `src/extension/review.ts`

`propose_edit`, `create_file` and `run_command` are listed in the agent spec's `require_approval_for_tools`, so TrueForge pauses the turn on `tool.approval_required`. Then:

1. `proposalFromCall()` applies the call's search/replace blocks in memory (`applySearchReplace()` in `src/core/edits.ts`) and splits the result into hunks (`computeHunks()`).
2. `ReviewManager` opens the diff editor with Accept/Reject CodeLens on each hunk; the panel shows the same controls.
3. `recordReview()` stores the accepted subset in the `ApprovalBook` against the call's canonical arguments, and the extension answers TrueForge with `user.tool_approval` (allow, or deny with a reason that names the rejected hunks).
4. TrueForge executes the approved MCP call. `applyDecision()` writes exactly the recorded subset (`applyHunks()`), journals it for undo (`src/core/journal.ts`) and tells the model which hunks landed and which were rejected.

A write happens only inside one complete approved call, which is why a cancelled run cannot leave a half-applied file.

## 6. Undo: `src/core/journal.ts`

`ChangeJournal` keeps the before and after text of every applied call. Undo restores the before text, and refuses if the file changed after the edit.

## 7. Tests and checks

- `test/edits.test.ts`: search/replace, hunks, partial acceptance, CRLF, final newlines, and two 3,000-case fuzz tests.
- `test/core.test.ts`: the approval book, error classes, undo, path safety, command environment.
- `test/retriever.test.ts`: Task B's context pack on a real Flask checkout.
- `scripts/e2e.sh` (run by `./check.sh`): a real VS Code with the extension against a running TrueForge: Task A, undo, Stop mid-run, and Task C with an unreachable first model.
- `scripts/matrix.sh`: Tasks A and B headless, once per model, results in `evidence/results/matrix.csv`.
