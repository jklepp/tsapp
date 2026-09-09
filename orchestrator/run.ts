/**
 * Run one orchestration end to end: load specs, build the graph, invoke it,
 * write the ledger and summary. Which agents run is injected, so the same
 * function serves `--stub` runs, tests, and the real thing.
 */
import { branchFor } from "./agents/coder.js";
import type { Coder, Integrator } from "./agents/types.js";
import type { OrchestratorConfig } from "./config.js";
import { branchExists, mergedBranches } from "./git.js";
import { buildGraph, recursionLimitFor } from "./graph.js";
import { Ledger, summarize, writeSummary, type RunSummary } from "./metrics.js";
import { loadSpecs, validateSpecs } from "./spec.js";
import { initialPrRecords } from "./state.js";

export interface RunOptions {
  coder: Coder;
  integrator: Integrator;
  runId?: string;
  /** Called with a one-line description of every event. */
  onLog?: (line: string) => void;
}

export function newRunId(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
}

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
    case "run:start": {
      const skipped = data.skipped as string[];
      return (
        `run started: ${(data.specs as string[]).length} spec(s), ${data.coders} coder(s)` +
        (skipped.length
          ? `; already merged, skipping: ${skipped.join(", ")}`
          : "")
      );
    }
    case "run:end":
      return `run finished: ${data.merged} merged, ${data.failed} failed, $${(data.costUsd as number).toFixed(4)}`;
    default:
      return `${type} ${JSON.stringify(data)}`;
  }
}

/** Branch names already contained in the integration branch, if it exists. */
async function alreadyMerged(config: OrchestratorConfig): Promise<Set<string>> {
  if (!(await branchExists(config.repoPath, config.integrationBranch))) {
    return new Set();
  }
  return new Set(
    await mergedBranches(config.repoPath, config.integrationBranch),
  );
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
  const ledger = new Ledger(config.runsDir, runId);
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    ledger.event(type, data);
    opts.onLog?.(describeEvent(type, data));
  };

  // Specs whose branch is already in integration are done; mark them merged
  // up front so dependants can proceed and nothing is built twice. This is
  // what makes re-running after a crash or a partial failure safe.
  const prs = initialPrRecords(specs);
  const done = await alreadyMerged(config);
  const skipped = specs
    .filter((s) => done.has(branchFor(s.id)))
    .map((s) => s.id);
  for (const id of skipped) {
    prs[id] = { ...prs[id], status: "merged", branch: branchFor(id) };
  }

  emit("run:start", {
    specs: specs.map((s) => s.id),
    skipped,
    coders: config.coders.count,
  });
  const graph = buildGraph({
    config,
    coder: opts.coder,
    integrator: opts.integrator,
    emit,
  });
  const final = await graph.invoke(
    { runId, prs },
    { recursionLimit: recursionLimitFor(specs.length, config) },
  );

  const summary = summarize(runId, final.prs);
  writeSummary(ledger.runDir, summary);
  emit("run:end", {
    merged: summary.rows.filter((r) => r.status === "merged").length,
    failed: summary.rows.filter((r) => r.status === "failed").length,
    costUsd: summary.totals.costUsd,
  });
  return summary;
}
