/**
 * The contract between the graph and the two LLM-backed roles.
 *
 * The graph never talks to a model directly. It calls a `Coder` for each
 * dispatched PR and an `Integrator` for each finished one, and only looks at
 * the small result objects they return. That is what lets Step 2 run the whole
 * pipeline with stubs, and lets tests run without spending a token.
 */
import type { OrchestratorConfig } from "../config.js";
import type { PhaseMetrics, PrRecord } from "../state.js";

export interface AgentContext {
  config: OrchestratorConfig;
  runId: string;
  /** 1 on the first try. On retries, `pr.error` carries the previous failure. */
  attempt: number;
}

export type CoderResult =
  | {
      outcome: "pr-open";
      branch: string;
      prNumber?: number;
      prUrl?: string;
      metrics: PhaseMetrics;
    }
  | {
      outcome: "failed";
      error: string;
      /** false when another attempt cannot help (e.g. the spec is unimplementable). */
      retryable?: boolean;
      metrics?: PhaseMetrics;
    };

/** Implement one spec in an isolated worktree and open a PR against integration. */
export type Coder = (pr: PrRecord, ctx: AgentContext) => Promise<CoderResult>;

export type IntegratorResult =
  | { outcome: "merged"; metrics: PhaseMetrics }
  | {
      /** Could not merge cleanly or checks failed; the PR goes back to a coder with `error` as feedback. */
      outcome: "rejected";
      error: string;
      retryable?: boolean;
      metrics?: PhaseMetrics;
    };

/** Merge one open PR into the integration branch and keep checks green. */
export type Integrator = (
  pr: PrRecord,
  ctx: AgentContext,
) => Promise<IntegratorResult>;
