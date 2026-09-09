/**
 * Run one orchestration end to end: load specs, build the graph, invoke it,
 * write the ledger and summary. Which agents run is injected, so the same
 * function serves `--stub` runs, tests, and the real thing.
 *
 * Every run has a thread id (the run id) and a SQLite checkpoint file in its
 * run directory. LangGraph writes a checkpoint after every superstep, so
 * `resumeOrchestrator` can continue a crashed or interrupted run from the
 * last completed wave, and `getRunState` can inspect a run at any time.
 */
import fs from "node:fs";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { Coder, Integrator } from "./agents/types.js";
import { SPEC_TRAILER, branchFor } from "./naming.js";
import type { OrchestratorConfig } from "./config.js";
import { branchExists, mergedBranches, trailerValues } from "./git.js";
import { buildGraph, recursionLimitFor } from "./graph.js";
import { Ledger, summarize, writeSummary, type RunSummary } from "./metrics.js";
import { loadSpecs, validateSpecs } from "./spec.js";
import { initialPrRecords, type PrRecord } from "./state.js";

export interface RunOptions {
  coder: Coder;
  integrator: Integrator;
  runId?: string;
  /** Called with a one-line description of every event. */
  onLog?: (line: string) => void;
  /** Abort the run (used by tests to simulate a crash mid-wave). */
  signal?: AbortSignal;
}

export function newRunId(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
}

/** High-frequency session events: recorded in the ledger, shown only by `watch`. */
export const LIVE_ONLY = new Set([
  "pr:session",
  "pr:turn",
  "pr:usage",
  "pr:session-end",
]);

export function describeEvent(
  type: string,
  data: Record<string, unknown>,
): string {
  const pr = data.prId ? `${data.prId}` : "";
  switch (type) {
    case "wave":
      return `wave: ${(data.ids as string[]).join(", ")}`;
    case "pr:dispatch":
      return `${pr}: coding (attempt ${data.attempt})`;
    case "pr:coded":
      return `${pr}: PR open${data.prUrl ? ` ${data.prUrl}` : ""}`;
    case "pr:coder-failed":
      return `${pr}: coder failed, ${data.willRetry ? "will retry" : "giving up"}: ${data.error}`;
    case "pr:integrating":
      return `${pr}: integrating`;
    case "pr:merged":
      return `${pr}: merged`;
    case "pr:rejected":
      return `${pr}: integration rejected, ${data.willRetry ? "back to queue" : "giving up"}: ${data.error}`;
    case "pr:blocked":
      return `${pr}: failed (${data.error})`;
    case "run:drained":
      return "nothing left to schedule";
    case "run:budget-exceeded":
      return `run budget reached: $${(data.spent as number).toFixed(4)} spent of $${data.budget}; not scheduling more`;
    case "run:start": {
      const skipped = data.skipped as string[];
      return (
        `run started: ${(data.specs as string[]).length} spec(s), ${data.coders} coder(s)` +
        (skipped.length
          ? `; already merged, skipping: ${skipped.join(", ")}`
          : "")
      );
    }
    case "run:resume":
      return `resuming run ${data.runId} from its last checkpoint (next: ${(data.next as string[]).join(", ") || "nothing"})`;
    case "run:end":
      return `run finished: ${data.merged} merged, ${data.failed} failed, $${(data.costUsd as number).toFixed(4)}`;
    default:
      return `${type} ${JSON.stringify(data)}`;
  }
}

/**
 * Spec ids already landed on the integration branch: every landing commit
 * carries an `Orch-Spec` trailer, whatever the merge strategy. Merge-commit
 * landings made before trailers existed are still recognised by ancestry.
 */
export async function alreadyMerged(
  config: OrchestratorConfig,
): Promise<Set<string>> {
  const { repoPath: repo, integrationBranch: target } = config;
  if (!(await branchExists(repo, target))) return new Set();
  const byTrailer = await trailerValues(repo, target, SPEC_TRAILER);
  const byAncestry = await mergedBranches(repo, target);
  const prefix = `${config.branchPrefix}/`;
  for (const b of byAncestry) {
    if (b.startsWith(prefix)) byTrailer.add(b.slice(prefix.length));
  }
  return byTrailer;
}

const checkpointFile = (config: OrchestratorConfig, runId: string) =>
  path.join(config.runsDir, runId, "checkpoints.sqlite");

const threadConfig = (runId: string) => ({
  configurable: { thread_id: runId },
});

/** The most recent run directory that has a checkpoint file, if any. */
export function latestRunId(config: OrchestratorConfig): string | undefined {
  if (!fs.existsSync(config.runsDir)) return undefined;
  return fs
    .readdirSync(config.runsDir)
    .filter((d) => fs.existsSync(checkpointFile(config, d)))
    .sort()
    .pop();
}

function setup(config: OrchestratorConfig, runId: string, opts: RunOptions) {
  const ledger = new Ledger(config.runsDir, runId);
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    ledger.event(type, data);
    // Per-turn progress is for `watch` and the ledger, not the run console.
    if (!LIVE_ONLY.has(type)) opts.onLog?.(describeEvent(type, data));
  };
  const checkpointer = SqliteSaver.fromConnString(
    checkpointFile(config, runId),
  );
  const graph = buildGraph(
    { config, coder: opts.coder, integrator: opts.integrator, emit },
    checkpointer,
  );
  // The SQLite handle must be closed explicitly, or the file stays locked.
  return { ledger, emit, graph, close: () => checkpointer.db.close() };
}

function finish(
  runId: string,
  prs: Record<string, PrRecord>,
  ledger: Ledger,
  emit: (type: string, data?: Record<string, unknown>) => void,
): RunSummary {
  const summary = summarize(runId, prs);
  writeSummary(ledger.runDir, summary);
  emit("run:end", {
    merged: summary.rows.filter((r) => r.status === "merged").length,
    failed: summary.rows.filter((r) => r.status === "failed").length,
    costUsd: summary.totals.costUsd,
  });
  return summary;
}

export async function runOrchestrator(
  config: OrchestratorConfig,
  opts: RunOptions,
): Promise<RunSummary> {
  const specs = loadSpecs(config.specsDir);
  const problems = validateSpecs(specs);
  if (problems.length) {
    throw new Error(`Specs are not runnable:\n  ${problems.join("\n  ")}`);
  }
  const runId = opts.runId ?? newRunId();
  const { ledger, emit, graph, close } = setup(config, runId, opts);

  // Specs whose branch is already in integration are done; mark them merged
  // up front so dependants can proceed and nothing is built twice. This is
  // what makes re-running after a crash or a partial failure safe.
  const prs = initialPrRecords(specs);
  const done = await alreadyMerged(config);
  const skipped = specs.filter((s) => done.has(s.id)).map((s) => s.id);
  for (const id of skipped) {
    prs[id] = { ...prs[id], status: "merged", branch: branchFor(config, id) };
  }

  emit("run:start", {
    specs: specs.map((s) => s.id),
    skipped,
    coders: config.coders.count,
  });
  try {
    const final = await graph.invoke(
      { runId, prs },
      {
        ...threadConfig(runId),
        recursionLimit: recursionLimitFor(specs.length, config),
        signal: opts.signal,
      },
    );
    return finish(runId, final.prs, ledger, emit);
  } finally {
    close();
  }
}

/**
 * Continue a run from its last checkpoint. Work that had finished before the
 * interruption is kept; tasks that were in flight are started again, and the
 * agents are built to cope with that (a coder resets or reuses its branch,
 * the integrator treats an already merged branch as merged).
 */
export async function resumeOrchestrator(
  config: OrchestratorConfig,
  runId: string,
  opts: RunOptions,
): Promise<RunSummary> {
  if (!fs.existsSync(checkpointFile(config, runId))) {
    throw new Error(`No checkpoint file for run ${runId}`);
  }
  const { ledger, emit, graph, close } = setup(config, runId, opts);
  try {
    const snapshot = await graph.getState(threadConfig(runId));
    if (!snapshot.values?.prs) {
      throw new Error(`Run ${runId} has no saved state to resume from`);
    }
    emit("run:resume", { runId, next: snapshot.next });
    const prCount = Object.keys(snapshot.values.prs).length;
    const final = await graph.invoke(null, {
      ...threadConfig(runId),
      recursionLimit: recursionLimitFor(prCount, config),
      signal: opts.signal,
    });
    return finish(runId, final.prs, ledger, emit);
  } finally {
    close();
  }
}

export interface RunStatus {
  runId: string;
  /** Graph nodes that would run next; empty when the run is complete. */
  next: string[];
  prs: Record<string, PrRecord>;
}

/** Read a run's latest checkpoint without executing anything. */
export async function getRunState(
  config: OrchestratorConfig,
  runId: string,
): Promise<RunStatus> {
  if (!fs.existsSync(checkpointFile(config, runId))) {
    throw new Error(`No checkpoint file for run ${runId}`);
  }
  const never = async () => {
    throw new Error("status is read-only");
  };
  const checkpointer = SqliteSaver.fromConnString(
    checkpointFile(config, runId),
  );
  try {
    const graph = buildGraph(
      { config, coder: never, integrator: never },
      checkpointer,
    );
    const snapshot = await graph.getState(threadConfig(runId));
    return {
      runId,
      next: [...(snapshot.next ?? [])],
      prs: snapshot.values?.prs ?? {},
    };
  } finally {
    checkpointer.db.close();
  }
}
