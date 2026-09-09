/**
 * The post-merge hook: a repo-owned command the orchestrator runs after
 * merges land on integration, e.g. to trigger heavy CI on a self-hosted
 * runner. The orchestrator knows nothing about what the command does; it
 * only decides when to run it (every N merges, at run end, or on demand).
 */
import type { OrchestratorConfig } from "./config.js";
import { runCommand, tail } from "./git.js";

export type Emit = (type: string, data?: Record<string, unknown>) => void;

export interface PostMergeTrigger {
  reason: "every-n" | "run-end" | "manual";
  mergedThisRun: number;
}

/** Run the configured command, if any, and record the outcome in the ledger. */
export async function firePostMerge(
  config: OrchestratorConfig,
  runId: string,
  trigger: PostMergeTrigger,
  emit: Emit,
): Promise<boolean> {
  const command = config.postMerge.command;
  if (!command) return false;
  emit("ci:trigger", { reason: trigger.reason, merged: trigger.mergedThisRun });
  const result = await runCommand(
    command,
    config.repoPath,
    config.checkTimeoutMs,
    {
      ORCH_RUN_ID: runId,
      ORCH_TRIGGER: trigger.reason,
      ORCH_MERGED: String(trigger.mergedThisRun),
      ORCH_INTEGRATION_BRANCH: config.integrationBranch,
    },
  );
  emit(result.ok ? "ci:triggered" : "ci:trigger-failed", {
    reason: trigger.reason,
    output: tail(result.output, 10),
  });
  return result.ok;
}

/** Should the every-N rule fire, given merges so far and the last firing point? */
export function dueEveryN(
  config: OrchestratorConfig,
  mergedThisRun: number,
  firedAt: number,
): boolean {
  const n = config.postMerge.everyNMerges;
  return !!config.postMerge.command && !!n && mergedThisRun - firedAt >= n;
}
