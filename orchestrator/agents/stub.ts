/**
 * Stub agents: no model, no git. They sleep briefly, return plausible metrics,
 * and can be told to fail on demand. Used by `orch run --stub` and by tests
 * so the scheduling, retry and accounting logic can be exercised for free.
 */
import { branchFor } from "../naming.js";
import type { PhaseMetrics } from "../state.js";
import type { Coder, Integrator, Reviewer } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function fakeMetrics(startedAt: Date, scale = 1): PhaseMetrics {
  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    apiDurationMs: Math.round(
      (finishedAt.getTime() - startedAt.getTime()) * 0.8,
    ),
    numTurns: 10 * scale,
    inputTokens: 4000 * scale,
    outputTokens: 1500 * scale,
    cacheReadTokens: 30000 * scale,
    cacheCreationTokens: 6000 * scale,
    costUsd: 0.25 * scale,
    model: "stub",
  };
}

export interface StubOptions {
  /** Simulated work time per call, in milliseconds. */
  delayMs?: number;
  /** PR ids whose first coding attempt fails; later attempts succeed. */
  failOnce?: string[];
  /** PR ids whose every coding attempt fails. */
  failAlways?: string[];
  /** PR ids the stub reviewer blocks on their first review only. */
  reviewBlockOnce?: string[];
  /** PR ids the stub reviewer always blocks. */
  reviewBlockAlways?: string[];
}

export function stubCoder(opts: StubOptions = {}): Coder {
  return async (pr, ctx) => {
    const startedAt = new Date();
    await sleep(opts.delayMs ?? 50);
    const failOnce = opts.failOnce?.includes(pr.id) && ctx.attempt === 1;
    if (failOnce || opts.failAlways?.includes(pr.id)) {
      return {
        outcome: "failed",
        error: `stub: simulated failure on attempt ${ctx.attempt}`,
        metrics: fakeMetrics(startedAt, 0.5),
      };
    }
    const branch = branchFor(ctx.config, pr.id);
    return {
      outcome: "pr-open",
      branch,
      prUrl: `stub://${branch}`,
      metrics: fakeMetrics(startedAt),
    };
  };
}

export function stubIntegrator(opts: StubOptions = {}): Integrator {
  return async () => {
    const startedAt = new Date();
    await sleep(opts.delayMs ?? 20);
    return { outcome: "merged", metrics: fakeMetrics(startedAt, 0.2) };
  };
}

export function stubReviewer(opts: StubOptions = {}): Reviewer {
  const seen = new Set<string>();
  return async (pr) => {
    const startedAt = new Date();
    await sleep(opts.delayMs ?? 20);
    const first = !seen.has(pr.id);
    seen.add(pr.id);
    const block =
      opts.reviewBlockAlways?.includes(pr.id) ||
      (first && opts.reviewBlockOnce?.includes(pr.id));
    return {
      outcome: block ? "block" : "pass",
      findings: block
        ? "- **BLOCKING** stub: simulated review finding\nVERDICT: BLOCK"
        : "VERDICT: PASS",
      metrics: fakeMetrics(startedAt, 0.1),
    };
  };
}
