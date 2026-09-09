/**
 * The integration agent.
 *
 * Most merges need no model at all, so the harness tries the cheap path first
 * and only starts a session when it has to:
 *
 *   1. fetch, fast-forward the integration branch, fresh worktree on it
 *   2. compose: `git merge --no-ff` (mergeStrategy "merge") or
 *      `git merge --squash` ("squash") of pr/<id>
 *        clean          -> go to 3
 *        already merged -> done (idempotent, so a retry after a crash is safe)
 *        conflict       -> ONE model session resolves it in place
 *   3. run the integrator's check command in the harness
 *        passes -> done
 *        fails, and no session has run yet -> ONE model session fixes it
 *        still fails -> reject
 *   4. land. Every landing commit carries an `Orch-Spec: <id>` trailer, which
 *      is how later runs know the spec is done regardless of strategy.
 *        merge:  push integration; GitHub marks the PR merged by ancestry.
 *        squash: when the PR merged cleanly, ask GitHub to squash it
 *                (`gh pr merge --squash --match-head-commit`) so the PR shows
 *                as merged, then adopt GitHub's commit locally. When a conflict
 *                had to be resolved here, the resolution exists only locally,
 *                so push the local squash commit and close the PR with a note.
 *        no remote: the local commit is the landing.
 *
 * On any rejection the worktree is reset to where it was, so a bad PR can
 * never leave integration broken. The rejection text goes back to a coder as
 * feedback for the next attempt.
 */
import fs from "node:fs";
import matter from "gray-matter";
import type { OrchestratorConfig } from "../config.js";
import {
  addWorktree,
  commitAll,
  deleteRemoteBranch,
  fetch,
  ghClosePr,
  ghSquashMerge,
  hasRemote,
  isClean,
  linkNodeModules,
  merge,
  mergeAbort,
  push,
  remoteSha,
  removeWorktree,
  resetHard,
  revParse,
  runCommand,
  squashMerge,
  syncBranch,
  tail,
  unmergedFiles,
} from "../git.js";
import { SPEC_TRAILER, branchFor, integrationWorktreeDir } from "../naming.js";
import type { PhaseMetrics, PrRecord } from "../state.js";
import { parseBlocked } from "./coder.js";
import { runAgentSession, type SessionRunner } from "./session.js";
import type { Integrator, IntegratorResult } from "./types.js";

export const INTEGRATOR_RULES = `
You are the integration agent. You merge finished PR branches into the integration branch and keep it green. You work unattended in a git worktree; nobody will answer questions. The Bash tool is POSIX sh, not PowerShell.

Rules:
- Make the smallest change that completes the merge correctly. Resolve conflicts and fix breakage caused by the merge; do not refactor, restyle, or improve anything else.
- Keep the intent of both sides of a conflict. Never discard one side's work without a reason you state in your summary.
- Run the check command given in the message before you finish, and fix what it reports.
- Commit with the message given in the message. Do not push, do not touch other branches.
- Finish with a 2 to 4 line summary of what you resolved.
- If the two sides are genuinely incompatible, make no changes and reply with a single line starting with "BLOCKED:" and the reason.
`.trim();

/** Subject line of the commit that lands a PR on integration. */
export function landingSubject(pr: PrRecord, config: OrchestratorConfig) {
  const ref = pr.prNumber !== undefined ? ` (#${pr.prNumber})` : "";
  return config.mergeStrategy === "squash"
    ? `${pr.id}: ${pr.title}${ref}`
    : `Merge ${branchFor(config, pr.id)}: ${pr.title}${ref}`;
}

/** Full landing message: subject, blank line, the spec trailer. */
export function landingMessage(pr: PrRecord, config: OrchestratorConfig) {
  return `${landingSubject(pr, config)}\n\n${SPEC_TRAILER}: ${pr.id}`;
}

export function conflictPrompt(
  pr: PrRecord,
  branch: string,
  files: string[],
  specBody: string,
  config: OrchestratorConfig,
): string {
  return [
    `# Resolve merge conflicts: ${branch} into ${config.integrationBranch}`,
    "",
    `The merge is already in progress in this worktree (\`git status\` shows it). Conflicted files:`,
    ...files.map((f) => `- ${f}`),
    "",
    `Check command: \`${integratorCheck(config)}\``,
    `Commit message: \`${landingSubject(pr, config)}\` (use \`git commit -m\`; the merge state is preserved)`,
    "",
    `## What the PR being merged intends (${pr.id})`,
    "",
    specBody.trim(),
  ].join("\n");
}

export function fixPrompt(
  pr: PrRecord,
  branch: string,
  checkOutput: string,
  config: OrchestratorConfig,
): string {
  return [
    `# Fix the checks after merging ${branch} into ${config.integrationBranch}`,
    "",
    "The merge applied cleanly and is already committed, but the check command now fails. Usually two PRs changed neighbouring code in compatible-looking but incompatible ways.",
    "",
    `Check command: \`${integratorCheck(config)}\``,
    `Commit message: \`Fix checks after merging ${branch}\``,
    "",
    "## Check output",
    "",
    "```",
    checkOutput,
    "```",
  ].join("\n");
}

/** Metrics for an integration that needed no model: time only. */
export function zeroMetrics(startedAt: Date): PhaseMetrics {
  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    apiDurationMs: 0,
    numTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    model: "none",
  };
}

const integratorCheck = (config: OrchestratorConfig) =>
  config.integrator.checkCommand ?? config.checkCommand;

export interface IntegratorDeps {
  runSession?: SessionRunner;
}

export function createIntegrator(deps: IntegratorDeps = {}): Integrator {
  const runSession = deps.runSession ?? runAgentSession;

  return async (pr, ctx): Promise<IntegratorResult> => {
    const { config, attempt } = ctx;
    const repo = config.repoPath;
    const target = config.integrationBranch;
    const branch = pr.branch ?? branchFor(config, pr.id);
    const dir = integrationWorktreeDir(config);
    const logFile = `${config.runsDir}/${ctx.runId}/logs/${pr.id}-attempt${attempt}-integrator.log`;
    const startedAt = new Date();
    const checkCommand = integratorCheck(config);

    await syncBranch(repo, target, config.baseBranch, {
      fetch: config.fetchBeforeWork,
    });
    const remote = await hasRemote(repo);
    await addWorktree(repo, dir, target, target, false);
    const before = await revParse(dir);
    const headSha = await revParse(repo, branch);
    let metrics: PhaseMetrics | undefined;
    let conflicted = false;

    /** Undo everything since `before` and hand the PR back with feedback. */
    const reject = async (error: string): Promise<IntegratorResult> => {
      await mergeAbort(dir);
      await resetHard(dir, before);
      return { outcome: "rejected", error, metrics };
    };

    const finish = (): IntegratorResult => ({
      outcome: "merged",
      metrics: metrics ?? zeroMetrics(startedAt),
    });

    try {
      if (config.linkNodeModules) linkNodeModules(repo, dir);

      const outcome =
        config.mergeStrategy === "squash"
          ? await squashMerge(dir, branch)
          : await merge(dir, branch, landingMessage(pr, config));
      if (outcome.status === "up-to-date") return finish();

      if (outcome.status === "conflict") {
        conflicted = true;
        const specBody = matter(fs.readFileSync(pr.specPath, "utf8")).content;
        const session = await runSession({
          cwd: dir,
          prompt: conflictPrompt(pr, branch, outcome.files, specBody, config),
          systemAppend: INTEGRATOR_RULES,
          settings: config.integrator,
          logFile,
        });
        metrics = session.metrics;
        if (session.result.subtype !== "success") {
          return await reject(
            `conflict resolution session ended with ${session.result.subtype}`,
          );
        }
        const blocked = parseBlocked(session.finalText);
        if (blocked) {
          return await reject(
            `merging into ${target} conflicted in ${outcome.files.join(", ")} and could not be resolved: ${blocked}`,
          );
        }
        const remaining = await unmergedFiles(dir);
        if (remaining.length) {
          return await reject(
            `merging into ${target} left unresolved conflicts in ${remaining.join(", ")}`,
          );
        }
      }
      // A squash leaves the result staged; a resolved conflict may too.
      if (!(await isClean(dir))) {
        await commitAll(dir, landingMessage(pr, config));
      }

      let check = await runCommand(checkCommand, dir, config.checkTimeoutMs);
      if (!check.ok && !metrics) {
        const session = await runSession({
          cwd: dir,
          prompt: fixPrompt(pr, branch, tail(check.output), config),
          systemAppend: INTEGRATOR_RULES,
          settings: config.integrator,
          logFile,
        });
        metrics = session.metrics;
        if (
          session.result.subtype === "success" &&
          !parseBlocked(session.finalText)
        ) {
          if (!(await isClean(dir))) {
            await commitAll(dir, `Fix checks after merging ${branch}`);
          }
          check = await runCommand(checkCommand, dir, config.checkTimeoutMs);
        }
      }
      if (!check.ok) {
        return await reject(
          `checks fail after merging into ${target} (${checkCommand}):\n${tail(check.output)}`,
        );
      }

      if (remote && config.pushIntegration) {
        await land(pr, branch, dir, headSha, conflicted, config);
      }
      return finish();
    } catch (err) {
      return await reject((err as Error).message);
    } finally {
      await removeWorktree(repo, dir);
    }
  };
}

/**
 * Publish a verified landing. Squash + clean merge + a known PR number is the
 * only case where GitHub does the commit; everything else pushes ours.
 */
async function land(
  pr: PrRecord,
  branch: string,
  dir: string,
  headSha: string,
  conflicted: boolean,
  config: OrchestratorConfig,
) {
  const repo = config.repoPath;
  const target = config.integrationBranch;
  const serverSquash =
    config.mergeStrategy === "squash" &&
    pr.prNumber !== undefined &&
    !conflicted &&
    config.openPullRequests;

  if (serverSquash) {
    await ghSquashMerge(repo, pr.prNumber!, {
      subject: landingSubject(pr, config),
      body: `${SPEC_TRAILER}: ${pr.id}`,
      matchHeadCommit: headSha,
      deleteBranch: config.deleteMergedBranches,
    });
    // Adopt GitHub's squash commit as the local integration tip.
    await fetch(repo);
    await resetHard(dir, `origin/${target}`);
    return;
  }

  await push(dir, target, { force: false });
  if (config.mergeStrategy === "squash" && pr.prNumber !== undefined) {
    const sha = await revParse(dir);
    await ghClosePr(
      repo,
      pr.prNumber,
      `Landed on ${target} as ${sha.slice(0, 7)}; the integrator resolved conflicts locally, so the commit is not reachable from this branch.`,
    );
  }
  if (
    config.deleteMergedBranches &&
    (await remoteSha(repo, branch)) === headSha
  ) {
    await deleteRemoteBranch(repo, branch);
  }
}
