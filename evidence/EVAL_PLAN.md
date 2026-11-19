# Evaluation plan

This plan is written and committed before any evaluation run. The commit hash and time of this file show that the question, the data, the baseline and the success rule were fixed before any result existed. If something has to change after a run, the change goes under "Changes after the first run" with its reason, and the original lines stay as they were.

There are no real users in this evaluation. Nobody was recruited, messaged or contacted for it, and our own traffic counts as testing, never as usage.

## Question
When a real change to pallets/flask is described in words, does Countersign's retriever put every file that change edited into its 10,000-token context pack more often than the BM25 whole-file retrieval baseline at the same budget?

## Metric and threshold
- Metric (primary): share of commits where every target file is in the context pack ("all found"). Target files = files the commit modified that existed at its parent, are text, and are not CHANGES.rst (changelog lines are bookkeeping, not code to find). Pack = what each method fits into 10,000 estimated tokens (characters / 3.6).
- Metric (secondary): mean per-commit recall of target files in each method's top 5 ranked files (no budget).
- Threshold: on the test slice, ours minus baseline on the primary metric is above 0, with the low end of the paired bootstrap 95% interval above 0.
- Interval: 95%, from `python3 evidence/interval.py` (Wilson for k of n, bootstrap for a mean or a difference)

## Data
- Dataset: git history of pallets/flask, https://github.com/pallets/flask, BSD-3-Clause.
- Version or hash: commits reachable from tag 3.1.3 (22d92470). Each commit is evaluated on the repository as it was at its parent, read from git objects.
- Selection (fixed now): non-merge commits; 2 to 8 target files; commit subject at least 20 characters; subject not starting with "Merge", "Bump", "Release", "release version", "[pre-commit", "update requirements", "Update requirements". Query = commit subject plus body, cut at 600 characters.
- Split: building slice = commits dated before 2023-01-01 (not used for tuning; the retriever was tuned only on the Task B instruction of this hackathon, written before this plan). Test slice = commits dated 2023-01-01 to 2026-02-18 (3.1.3).

## Baseline
- Whose: BM25 sparse retrieval over whole files, filled in rank order up to the token budget, the retrieval baseline of SWE-bench (Jimenez et al., "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?", ICLR 2024, https://arxiv.org/abs/2310.06770). They report it on SWE-bench, not on this split; we run it ourselves on the same commits and tokenizer.

## Success rule
On the test slice, the paired difference (ours minus baseline) in "all found" has a 95% bootstrap interval whose low end is above 0. Anything else is reported as not supported, with the numbers.

## Models and seeds
- Models: none (retrieval only; no model call).
- Seeds: bootstrap seed 7 (evidence/interval.py default), 10,000 draws.

## How results are reported
Every result names its kind at first mention, gives n, the source, the period and a 95% interval, and links its rerun command and commit. Measured numbers and estimates are kept apart, and failures are shown next to successes.

| Kind | Label at first mention | Travels with the number | Never used for this kind |
|---|---|---|---|
| Replay on public data | Back-test on public data (<dataset>, <years>) | n records, source and licence, period, whose baseline, 95% interval, rerun command and commit | `users`, `patients helped`, `customers`, `pilot`, `deployed with`, `proven`, `clinically validated` |
| Estimate from a replay | Estimate, not an observed result | the assumptions, and the data fields used to price it | `impact achieved`, `saved X hours for users`, `lives saved` |
| Real public system | Test transactions from wallets we control (addresses listed), or replayed in our own forks | counts, links, addresses | `users`, `volume`, `traction` |
| Break test | Our own break test (we tried to make it fail) | what we tried, how many attempts, what broke and what we fixed | `users`, `testers`, `validated` |

The README and the submission text open their evidence section with one line before any number:

> Evidence, stated plainly: no real users yet; it was built for this hackathon. Instead: <a back-test on <dataset> against <published baseline>>, <test transactions from wallets we control>, <our own break test of <the main claim>>. Each one reruns from the repo with one command.

Then one card per claim:

> Claim: <product> <does k of n <cases>> at <budget>.
> Evidence type: <label from the table above>, not real users.
> Data: <dataset, link, licence>, <period>, <n rows>. Baseline: <source> scores <x> on the same split.
> Result: <y> (95% interval <a> to <b>).
> Rerun: `<command>` at commit <hash>. Limits: <historical data, no live behaviour; any specific skew>.

Then a short limits paragraph, in numbers: zero real users, the interval, the data's years, and the next real test, with the metric and threshold that would change the conclusion.

## Changes after the first run
<None yet. Each change: the date, what changed, and why.>
