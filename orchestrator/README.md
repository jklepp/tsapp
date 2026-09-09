# PR Orchestrator

A LangGraph workflow that takes a queue of PR specs, has three coding agents
build and test them in parallel, and has one integrator agent merge the
results onto the `integration` branch. Deploying to `main` stays a human
decision.

## The four agents

| Agent        | Count | Brain                    | Job                                                                                        |
| ------------ | ----- | ------------------------ | ------------------------------------------------------------------------------------------ |
| Orchestrator | 1     | Plain code (no LLM)      | Loads specs, orders them, keeps 3 coders busy, retries failures, writes metrics.           |
| Coder        | 3     | Claude via the Agent SDK | In its own git worktree: implement one spec, write unit tests, run checks, push, open PR.  |
| Integrator   | 1     | Claude via the Agent SDK | Merge finished PRs one at a time into `integration`, resolve conflicts, keep checks green. |

The orchestrator is deliberately not a model. Ordering a queue, counting free
slots and deciding when to retry are deterministic, so spending tokens on them
would only add cost and variance. Every token in a run is spent by a coder or
the integrator, and every one of those tokens is attributed to a PR.

## How a run proceeds

The graph loops `schedule -> code (x3 in parallel) -> integrate -> schedule` until
nothing is left to schedule. One loop is a wave. `schedule` picks up to three
queued PRs whose dependencies are merged and whose `touches` do not overlap,
highest priority first. A failed coder or a rejected merge sends the PR back to
the queue with the error as feedback, up to `maxAttemptsPerPr`; after that it is
marked failed and anything depending on it is failed too, so the run always
terminates. Metrics accumulate across attempts, so a PR that took two tries
reports the tokens of both.

A wave waits for its slowest PR before the next starts. That costs some idle
time but keeps the run a small deterministic state machine that LangGraph can
checkpoint between nodes and resume after a crash (Step 5).

## What a coder actually does

The model only does the creative part. Around it, plain code does the rest,
in this order:

1. Create branch `pr/<id>` in its own worktree, cut from `integration`. On a
   retry the existing branch is reused, so attempt 2 builds on the commits of
   attempt 1 instead of paying to redo them.
2. Junction the repo's `node_modules` into the worktree (no reinstall).
3. Run one Agent SDK session confined to that worktree. Tools are an allowlist
   (`coders.allowedTools`): file tools plus `npm`, `npx`, `node` and `git` in
   Bash. Anything else is denied without prompting. The session also has hard
   caps: `maxTurns` and `maxBudgetUsd`.
4. Gate: the harness commits anything the agent left uncommitted, requires at
   least one commit, then runs `checkCommand` itself. The agent's own claim
   that checks pass is never trusted.
5. If the repo has a remote, push and `gh pr create --base integration`.
   Without a remote the branch stays local and the integrator merges it.
6. Remove the worktree. The branch and a transcript in
   `.orchestrator/runs/<runId>/logs/` remain.

A failure returns its reason (check output, "no changes", a cap hit) as
feedback the retry reads. An agent that answers `BLOCKED: <reason>` marks the
PR failed immediately, because another attempt would only spend more tokens.

## What the integrator actually does

Most merges need no model, so the harness tries the cheap path first:

1. Fresh worktree on `integration`, note the current commit.
2. `git merge --no-ff pr/<id>`. A clean merge goes straight to step 3. A
   branch that is already in `integration` counts as merged, which makes
   retries after a crash safe. A conflict starts one model session in that
   worktree with the conflicted file list and the PR's spec, and the harness
   then verifies no conflict markers remain and completes the merge commit.
3. Run `checkCommand` in the harness. If it fails and no session has run yet,
   one session gets the check output and a mandate to make the smallest fix.
   At most one session runs per integration attempt.
4. Push `integration` when the repo has a remote. GitHub then closes the PR as
   merged on its own, because the PR's commits are now in the base branch.

Any rejection resets `integration` to the commit from step 1, so a bad PR can
never leave the shared branch broken. The rejection text goes back to a coder
as feedback, and that coder's retry starts by merging `integration` into its
branch.

PRs are integrated one at a time, in priority order, because two merges into
one branch cannot safely run at once. The `Integr.` column in the summary
shows the time this took and the tokens it cost, which is usually zero.

## Re-running

At the start of every run, any spec whose `pr/<id>` branch is already
contained in `integration` is marked merged before scheduling. So the specs
folder is a permanent record of what you asked for, and `run` after a crash,
a partial failure, or adding new specs only builds what is missing.

## Data flow

```
.orchestrator/prs/*.md          orchestrator.config.json
        |                                |
        v                                v
  [load + validate]  ---------->  [LangGraph state: one small record per PR]
                                         |
             +---------------------------+---------------------------+
             v                           v                           v
      coder (worktree A)          coder (worktree B)          coder (worktree C)
      reads ONE spec body         reads ONE spec body         reads ONE spec body
      codes + tests + PR          codes + tests + PR          codes + tests + PR
             |                           |                           |
             +---------------------------+---------------------------+
                                         v
                               integrator (sequential)
                               merge PR -> run checks -> next
                                         v
                              `integration` branch + run metrics
```

## Static storage (why context stays small)

Every PR is a markdown file with YAML frontmatter in `.orchestrator/prs/`.
Only the frontmatter (id, title, priority, `depends_on`, `touches`) is loaded
into orchestrator state. The body, which can be as long as you like, is read
from disk by exactly one coder, once. Fifteen PRs or fifty, the orchestrator's
own state is a few kilobytes.

Frontmatter fields:

- `id`: lowercase letters, digits and dashes. Becomes the branch name.
- `title`: becomes the PR title.
- `priority`: 1 (first) to 5 (last), default 3.
- `depends_on`: ids that must be merged before this one starts.
- `touches`: paths this PR will edit. Two PRs that touch the same path are
  never coded at the same time, which avoids most merge conflicts up front.

Run output goes to `.orchestrator/runs/<runId>/` (git-ignored):

- `ledger.jsonl`: append-only event log, one JSON object per line.
- `summary.json` and `summary.md`: per-PR tokens, cost and durations, with totals.

## Metrics

Every Agent SDK session ends with a `result` message. Its `modelUsage` map is
the exact token count for that session, split by model, including any
subagents the coder spawned. `phaseMetricsFromResult()` in `metrics.ts` turns
that into a `PhaseMetrics` row (input, output, cache read, cache write,
estimated USD, turns, API time, wall time). A PR gets one row for coding and
one for integration; the summary adds them.

Cost is the SDK's client-side estimate from a bundled price table. It is close
to the bill but not the bill; the Claude Console usage page is authoritative.

## Files

| File                       | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `config.ts`                | Schema and loader for `orchestrator.config.json`.              |
| `spec.ts`                  | Parse, validate and order PR specs; wave preview.              |
| `state.ts`                 | LangGraph state (`RunState`) and the per-PR record type.       |
| `metrics.ts`               | Token accounting, JSONL ledger, summary table.                 |
| `graph.ts`                 | The LangGraph state machine: schedule, code (x3), integrate.   |
| `git.ts`                   | Deterministic git, gh and shell helpers used by the harness.   |
| `run.ts`                   | Runs one orchestration: specs -> graph -> ledger + summary.    |
| `agents/types.ts`          | The `Coder` and `Integrator` contracts the graph calls.        |
| `agents/stub.ts`           | Free stand-ins for both roles, used by `run --stub` and tests. |
| `agents/session.ts`        | One sandboxed Agent SDK session with transcript and metrics.   |
| `agents/coder.ts`          | The real coder: worktree, session, gates, push, PR.            |
| `agents/integrator.ts`     | The integrator: merge, check, session only on trouble, reset.  |
| `cli.ts`                   | `validate`, `plan`, `smoke`, `run --stub` commands.            |
| `orchestrator.config.json` | Per-project settings, lives in the target repo root.           |

## Commands

```
npm run orch -- validate    # parse every spec, report problems
npm run orch -- plan        # dependency order and wave preview
npm run orch -- smoke       # one tiny model call; prints a metrics row
npm run orch -- run --stub  # whole pipeline with stub agents, zero cost
npm run orch -- run         # everything, with the real agents (spends tokens)
npm run orch -- code <id>   # real coder on one spec, outside the graph (spends tokens)
npm run orch -- integrate <id>  # merge pr/<id> into integration (free unless it conflicts)
     [--fail-once <id>]     # simulate one failed coding attempt for that PR
     [--fail <id>]          # simulate a PR that never succeeds
npm run orch:typecheck      # type-check this folder (also part of npm run check)
```

## Reusing in another project

Copy the `orchestrator/` folder, add the same devDependencies
(`@langchain/langgraph`, `@langchain/core`, `@anthropic-ai/claude-agent-sdk`,
`zod`, `gray-matter`, `tsx`, `@types/node`), create `orchestrator.config.json`
with that project's `checkCommand`, and put specs in `.orchestrator/prs/`.
Nothing in this folder imports from the application code.

## Build steps

1. Foundations: specs, config, state, metrics, CLI. **Done.**
2. The graph: LangGraph nodes and edges, the 3-slot scheduler, retries, stub agents. **Done.**
3. The coder: git worktree per PR, sandboxed Agent SDK session, harness-run check gate, push and PR. **Done.**
4. The integrator: sequential merge, `checkCommand` after each merge, model only on conflict or breakage, reset on rejection. Safe re-runs. **Done.**
5. Resilience: checkpointing so a crashed run resumes, retry budget, token and turn caps, run summary.
6. Dry run on this repo with the three sample specs, then tune prompts for token efficiency.
