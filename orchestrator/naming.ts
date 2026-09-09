/**
 * Branch and worktree names, derived from config so a repository with its own
 * branch-ownership rules (e.g. a pre-push hook keyed on worktree basename and
 * branch namespace) can be satisfied without touching orchestrator code.
 */
import path from "node:path";
import type { OrchestratorConfig } from "./config.js";

type Naming = Pick<
  OrchestratorConfig,
  | "branchPrefix"
  | "worktreesDir"
  | "worktreeNamePrefix"
  | "integrationWorktreeName"
>;

/** `<branchPrefix>/<spec id>`, e.g. `pr/001-footer-year`. */
export const branchFor = (config: Pick<Naming, "branchPrefix">, prId: string) =>
  `${config.branchPrefix}/${prId}`;

/** Absolute path of the coder worktree for a spec. */
export const worktreeDirFor = (
  config: Pick<Naming, "worktreesDir" | "worktreeNamePrefix">,
  prId: string,
) => path.join(config.worktreesDir, `${config.worktreeNamePrefix}${prId}`);

/** Absolute path of the integrator's worktree. */
export const integrationWorktreeDir = (
  config: Pick<Naming, "worktreesDir" | "integrationWorktreeName">,
) => path.join(config.worktreesDir, config.integrationWorktreeName);

/** Commit-message trailer that marks a spec as landed, whatever the merge strategy. */
export const SPEC_TRAILER = "Orch-Spec";
