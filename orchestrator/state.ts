/**
 * LangGraph state for one orchestration run.
 *
 * The state is deliberately small: one record per PR holding status, git
 * coordinates and metrics. No code, no diffs, no spec bodies. Three coders
 * update it concurrently, so the `prs` channel uses a merge-by-id reducer:
 * a node returns `{ prs: { [id]: updatedRecord } }` and LangGraph folds it in.
 */
import { Annotation } from "@langchain/langgraph";
import type { PrSpec } from "./spec.js";

export const PR_STATUSES = [
  "queued", // waiting for a free coder and for its dependencies to merge
  "coding", // a coding agent owns it in a worktree
  "pr-open", // branch pushed, GitHub PR open against the integration branch
  "integrating", // the integrator is merging it
  "merged", // on the integration branch
  "failed", // gave up after maxAttemptsPerPr
] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

/** Token and time accounting for one agent phase (coding or integration) of one PR. */
export interface PhaseMetrics {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  apiDurationMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Client-side estimate from the Agent SDK; close to, but not, the bill. */
  costUsd: number;
  model: string;
}

export interface PrRecord {
  id: string;
  title: string;
  specPath: string;
  priority: number;
  dependsOn: string[];
  touches: string[];
  status: PrStatus;
  attempts: number;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  error?: string;
  coding?: PhaseMetrics;
  integration?: PhaseMetrics;
}

export const RunState = Annotation.Root({
  runId: Annotation<string>,
  prs: Annotation<Record<string, PrRecord>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
  /** Append-only human-readable log lines, mirrored to the run ledger. */
  log: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

export type RunStateType = typeof RunState.State;

export function initialPrRecords(specs: PrSpec[]): Record<string, PrRecord> {
  return Object.fromEntries(
    specs.map((s) => [
      s.id,
      {
        id: s.id,
        title: s.title,
        specPath: s.specPath,
        priority: s.priority,
        dependsOn: s.dependsOn,
        touches: s.touches,
        status: "queued" as const,
        attempts: 0,
      },
    ]),
  );
}
