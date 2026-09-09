/**
 * The orchestration graph.
 *
 *   START -> schedule -> code (x N, in parallel) -> integrate -> schedule -> ... -> END
 *
 * One trip around the loop is a "wave":
 *   schedule   picks up to `coders.count` runnable PRs and marks them coding
 *   code       one node instance per picked PR, all running concurrently
 *   integrate  merges every finished PR, one at a time, in priority order
 *
 * The loop ends when schedule finds nothing runnable. LangGraph checkpoints
 * between nodes, so a crashed run can later resume at the last wave boundary.
 *
 * Trade-off, stated plainly: a wave waits for its slowest PR before the next
 * wave starts. In exchange the whole run is a small, deterministic state
 * machine that is easy to reason about, test and resume.
 */
import {
  Annotation,
  END,
  Send,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import type { Coder, Integrator } from "./agents/types.js";
import type { OrchestratorConfig } from "./config.js";
import { addPhaseMetrics } from "./metrics.js";
import { RunState, type PrRecord, type RunStateType } from "./state.js";

export interface GraphDeps {
  config: OrchestratorConfig;
  coder: Coder;
  integrator: Integrator;
  /** Receives every ledger event; wire it to Ledger.event and/or the console. */
  emit?: (type: string, data?: Record<string, unknown>) => void;
}

const byPriority = (a: PrRecord, b: PrRecord) =>
  a.priority - b.priority || a.id.localeCompare(b.id);

/**
 * Choose the next wave: queued PRs whose dependencies are all merged, highest
 * priority first, never two in the same wave that touch the same path.
 */
export function pickWave(
  prs: Record<string, PrRecord>,
  slots: number,
): PrRecord[] {
  const merged = new Set(
    Object.values(prs)
      .filter((p) => p.status === "merged")
      .map((p) => p.id),
  );
  const wave: PrRecord[] = [];
  const touched = new Set<string>();
  const candidates = Object.values(prs)
    .filter((p) => p.status === "queued")
    .filter((p) => p.dependsOn.every((d) => merged.has(d)))
    .sort(byPriority);
  for (const pr of candidates) {
    if (wave.length >= slots) break;
    if (pr.touches.some((t) => touched.has(t))) continue;
    wave.push(pr);
    pr.touches.forEach((t) => touched.add(t));
  }
  return wave;
}

/** Queued PRs that depend on a failed PR can never run; fail them too. */
export function propagateFailures(
  prs: Record<string, PrRecord>,
): Record<string, PrRecord> {
  const failed = new Set(
    Object.values(prs)
      .filter((p) => p.status === "failed")
      .map((p) => p.id),
  );
  const updates: Record<string, PrRecord> = {};
  let changed = true;
  while (changed) {
    changed = false;
    for (const pr of Object.values(prs)) {
      if (pr.status !== "queued" || updates[pr.id]) continue;
      const dead = pr.dependsOn.find((d) => failed.has(d));
      if (dead) {
        updates[pr.id] = {
          ...pr,
          status: "failed",
          error: `dependency ${dead} failed`,
        };
        failed.add(pr.id);
        changed = true;
      }
    }
  }
  return updates;
}

/** Input for one `code` node instance, delivered via Send(). */
const CoderInput = Annotation.Root({
  runId: Annotation<string>,
  pr: Annotation<PrRecord>,
});

/** Estimated USD spent so far across every PR and phase. */
export function totalCost(prs: Record<string, PrRecord>): number {
  return Object.values(prs).reduce(
    (n, p) => n + (p.coding?.costUsd ?? 0) + (p.integration?.costUsd ?? 0),
    0,
  );
}

/**
 * Build the graph. With a checkpointer, LangGraph saves the state after every
 * superstep under the run's thread id, which is what `resume` reads.
 */
export function buildGraph(
  deps: GraphDeps,
  checkpointer?: BaseCheckpointSaver,
) {
  const { config, coder, integrator } = deps;
  const emit = deps.emit ?? (() => {});

  const schedule = async (state: RunStateType) => {
    const blocked = propagateFailures(state.prs);
    for (const pr of Object.values(blocked)) {
      emit("pr:blocked", { prId: pr.id, error: pr.error });
    }
    const spent = totalCost(state.prs);
    const overBudget =
      config.maxRunBudgetUsd !== undefined && spent >= config.maxRunBudgetUsd;
    const wave = overBudget
      ? []
      : pickWave({ ...state.prs, ...blocked }, config.coders.count);
    const updates: Record<string, PrRecord> = { ...blocked };
    for (const pr of wave) {
      updates[pr.id] = { ...pr, status: "coding", attempts: pr.attempts + 1 };
      emit("pr:dispatch", { prId: pr.id, attempt: pr.attempts + 1 });
    }
    if (wave.length) emit("wave", { ids: wave.map((p) => p.id) });
    else if (overBudget)
      emit("run:budget-exceeded", { spent, budget: config.maxRunBudgetUsd });
    else emit("run:drained");
    return { prs: updates };
  };

  const routeAfterSchedule = (state: RunStateType) => {
    const coding = Object.values(state.prs).filter(
      (p) => p.status === "coding",
    );
    if (coding.length === 0) return END;
    return coding.map((pr) => new Send("code", { runId: state.runId, pr }));
  };

  const code = async (input: typeof CoderInput.State) => {
    const { pr, runId } = input;
    const ctx = {
      config,
      runId,
      attempt: pr.attempts,
      onEvent: (type: string, data: Record<string, unknown> = {}) =>
        emit(type, { prId: pr.id, ...data }),
    };
    let updated: PrRecord;
    try {
      const result = await coder(pr, ctx);
      const coding = addPhaseMetrics(pr.coding, result.metrics);
      if (result.outcome === "pr-open") {
        updated = {
          ...pr,
          status: "pr-open",
          branch: result.branch,
          prNumber: result.prNumber,
          prUrl: result.prUrl,
          error: undefined,
          coding,
        };
        emit("pr:coded", {
          prId: pr.id,
          attempt: pr.attempts,
          prUrl: updated.prUrl,
        });
      } else {
        updated = retryOrFail(
          { ...pr, coding },
          result.error,
          config,
          result.retryable,
        );
      }
    } catch (err) {
      updated = retryOrFail(pr, (err as Error).message, config);
    }
    if (updated.status !== "pr-open") {
      emit("pr:coder-failed", {
        prId: pr.id,
        attempt: pr.attempts,
        error: updated.error,
        willRetry: updated.status === "queued",
      });
    }
    return { prs: { [pr.id]: updated } };
  };

  const integrate = async (state: RunStateType) => {
    const open = Object.values(state.prs)
      .filter((p) => p.status === "pr-open")
      .sort(byPriority);
    const updates: Record<string, PrRecord> = {};
    for (const pr of open) {
      const ctx = {
        config,
        runId: state.runId,
        attempt: pr.attempts,
        onEvent: (type: string, data: Record<string, unknown> = {}) =>
          emit(type, { prId: pr.id, ...data }),
      };
      emit("pr:integrating", { prId: pr.id });
      let updated: PrRecord;
      try {
        const result = await integrator({ ...pr, status: "integrating" }, ctx);
        const integration = addPhaseMetrics(pr.integration, result.metrics);
        if (result.outcome === "merged") {
          updated = { ...pr, status: "merged", error: undefined, integration };
          emit("pr:merged", { prId: pr.id });
        } else {
          updated = retryOrFail(
            { ...pr, integration },
            result.error,
            config,
            result.retryable,
          );
          emit("pr:rejected", {
            prId: pr.id,
            error: result.error,
            willRetry: updated.status === "queued",
          });
        }
      } catch (err) {
        updated = retryOrFail(pr, (err as Error).message, config);
        emit("pr:rejected", {
          prId: pr.id,
          error: updated.error,
          willRetry: updated.status === "queued",
        });
      }
      updates[pr.id] = updated;
    }
    return { prs: updates };
  };

  return new StateGraph(RunState)
    .addNode("schedule", schedule)
    .addNode("code", code, { input: CoderInput })
    .addNode("integrate", integrate)
    .addEdge(START, "schedule")
    .addConditionalEdges("schedule", routeAfterSchedule, ["code", END])
    .addEdge("code", "integrate")
    .addEdge("integrate", "schedule")
    .compile({ checkpointer });
}

/** Send a PR back to the queue with feedback, or give up after the last allowed attempt. */
function retryOrFail(
  pr: PrRecord,
  error: string,
  config: OrchestratorConfig,
  retryable = true,
): PrRecord {
  const canRetry = retryable && pr.attempts < config.maxAttemptsPerPr;
  return { ...pr, status: canRetry ? "queued" : "failed", error };
}

/** Enough graph steps for every PR to use every attempt, plus slack. */
export function recursionLimitFor(
  prCount: number,
  config: OrchestratorConfig,
): number {
  const maxWaves = prCount * config.maxAttemptsPerPr + 1;
  return maxWaves * 3 + 5;
}
