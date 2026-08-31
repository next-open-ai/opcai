# Core Learnings

Most important durable learnings collected over time.
Last updated: 2026-08-18T19:46:43.092Z

This file keeps only top-ranked, most repeated items.
For the complete history, see long-term-memory.md.

Ranked by frequency + recency (with light decay over time).

## High-value learnings
- Closed PR #1 without merging after confirming its head SHA was already the intended private `main` commit.
- Fetched current `origin/main` and `origin/5.x`, verified each security commit’s parent exactly matched the corresponding remote tip, then used an atomic push.
- Verified public and private `main`/`5.x` refs matched, fast-forwarded local `main`, deleted temporary security branches, and confirmed a clean synchronized checkout.
- Obtained explicit approval before public disclosure, then atomically fast-forwarded `origin/main` to `af079bd4` and `origin/5.x` to `8acfea7e`, verifying both refs with `git ls-remote`.
- Fast-forwarded local `main` to `origin/main` and confirmed a clean synchronized status.
- Do not retry forbidden workspace GraphQL actions; use permitted repository operations or ask the user for an authorized alternative before attempting comments or metadata changes.
- Before any security-fix push, explicitly ask whether targets are the private advisory fork, public `origin`, or both; treat a draft advisory as a warning, not implicit authorization policy.
- Always state push destinations and exact resulting refs, e.g. `advisory-ghsa-3m5p/main` changed while `origin/main` remained at `6e95cb9f`.
- Run workspace-sensitive PR operations separately: attempt the comment, record an expected permission denial, then independently close only if authorized.
- Describe PR state from verified fields (`CLOSED`, `mergedAt: null`, head/base OIDs) rather than inferring that it is empty.

## Watch-outs
- Private PR #1 remained open after its head commit had already been placed on private `main`; its mergeability was `UNKNOWN` and it was no longer the correct landing path.
- Local `main` and temporary security branches were left out of sync after updating the remote branches.
- Direct public branch updates bypassed the repository’s pull-request-only rules, so ancestry and target refs required explicit validation to avoid unsafe rewrites.
- Initially pushed the security fix only to the private advisory fork, leaving `origin/main` and `origin/5.x` unchanged without first confirming the intended publication target.
- After pushing remote refs, local `main` remained one commit behind, creating temporary local/remote inconsistency.
- A GraphQL `addComment` action was attempted despite workspace-repository restrictions; the denial indicates an intentional permission boundary that should not be bypassed.
- Assumed the draft advisory meant `origin/main` and `origin/5.x` must remain untouched without first confirming whether the user expected public pushes.
- Reported that the private branches were complete without clearly distinguishing advisory-fork refs from public `origin` refs, prompting the user to stop and verify deployment status.
- Combined PR closing with an unsupported workspace-repository comment under `set -e`, causing the entire command to fail before the close could occur.
- Called the PR “now-empty” even though GitHub still reported it as mergeable with different head and base OIDs.
