/**
 * The coding agent.
 *
 * The model does the creative part only: read one spec, write the code and
 * tests, run the checks, commit. Everything around it is deterministic code:
 *
 *   1. branch `pr/<id>` in its own worktree, cut from the integration branch
 *      (or reused on a retry so the second attempt builds on the first)
 *   2. one Agent SDK session, sandboxed to that worktree
 *   3. gate: commits exist and the project's check command passes here, in the
 *      harness, regardless of what the agent claimed
 *   4. push (lease pinned to the sha we fetched, so nobody else's work is
 *      overwritten) and open a GitHub PR against integration when a remote exists
 *   5. remove the worktree; the branch and a transcript remain
 *
 * Failures return feedback the next attempt reads from `pr.error`.
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { OrchestratorConfig } from "../config.js";
import {
  addWorktree,
  commitAll,
  commitsAhead,
  createPullRequest,
  hasRemote,
  isClean,
  linkNodeModules,
  push,
  remoteSha,
  removeWorktree,
  runCommand,
  syncBranch,
  tail,
} from "../git.js";
import { branchFor, worktreeDirFor } from "../naming.js";
import type { PrRecord } from "../state.js";
import {
  forwardSessionEvents,
  runAgentSession,
  type SessionRunner,
} from "./session.js";
import type { Coder, CoderResult } from "./types.js";

export const CODER_RULES = `
You are implementing exactly one pull request from the spec in the user message. You are working unattended in a dedicated git worktree on a branch of your own; nobody will answer questions.

How to work:
- Read the spec, then read only the files you need. Do not re-read files you have already seen.
- Implement the spec and add or extend unit tests for the behaviour it describes.
- Use the Bash tool for commands; it is POSIX sh, not PowerShell.
- Run the targeted test file while iterating. Run the full check command once at the end and fix whatever it reports. Do not re-run its individual parts afterwards.
- Commit all changes with the exact single-line message given in the spec, e.g. \`git commit -m "<message>"\`. Do not push, do not open a PR, do not touch other branches.
- Stay inside the spec: no unrelated refactors, no new dependencies unless the spec asks, no changes to files the spec does not concern.
- Finish with a short summary (3 to 8 lines) of what changed and how it was tested. It becomes the PR description.
- If the spec cannot be implemented as written, make no changes and reply with a single line starting with "BLOCKED:" and the reason.
`.trim();

export function buildCoderPrompt(
  pr: PrRecord,
  specBody: string,
  config: OrchestratorConfig,
  attempt: number,
): string {
  const parts = [
    `# PR ${pr.id}: ${pr.title}`,
    "",
    `Commit message to use: \`${pr.id}: ${pr.title}\``,
    `Full check command: \`${config.checkCommand}\``,
    "",
    "## Spec",
    "",
    specBody.trim(),
  ];
  if (attempt > 1 && pr.error) {
    parts.push(
      "",
      `## Previous attempt (${attempt - 1}) failed`,
      "",
      "Your earlier commits on this branch are kept. Fix the problem below rather than starting over.",
      `If the failure came from merging into ${config.integrationBranch}, first run \`git merge ${config.integrationBranch}\`, resolve any conflicts, then fix and re-check.`,
      "",
      "```",
      pr.error.trim(),
      "```",
    );
  }
  return parts.join("\n");
}

export function parseBlocked(finalText: string): string | undefined {
  return finalText.match(/^BLOCKED:\s*(.+)$/m)?.[1]?.trim();
}

export interface CoderDeps {
  runSession?: SessionRunner;
}

export function createCoder(deps: CoderDeps = {}): Coder {
  const runSession = deps.runSession ?? runAgentSession;

  return async (pr, ctx): Promise<CoderResult> => {
    const { config, attempt } = ctx;
    const repo = config.repoPath;
    const branch = branchFor(config, pr.id);
    const dir = worktreeDirFor(config, pr.id);
    const logFile = path.join(
      config.runsDir,
      ctx.runId,
      "logs",
      `${pr.id}-attempt${attempt}-coder.log`,
    );

    // Start from the shared truth: fetch and fast-forward integration, and
    // remember where the remote PR branch is so the push can be pinned to it.
    await syncBranch(repo, config.integrationBranch, config.baseBranch, {
      fetch: config.fetchBeforeWork,
    });
    const remote = await hasRemote(repo);
    const expectedRemote = remote
      ? ((await remoteSha(repo, branch)) ?? null)
      : undefined;
    await addWorktree(
      repo,
      dir,
      branch,
      config.integrationBranch,
      attempt === 1,
    );
    try {
      if (config.linkNodeModules) linkNodeModules(repo, dir);
      if (config.worktreeSetupCommand) {
        const setup = await runCommand(
          config.worktreeSetupCommand,
          dir,
          config.checkTimeoutMs,
          {
            ORCH_PR_ID: pr.id,
            ORCH_BRANCH: branch,
            ORCH_ATTEMPT: String(attempt),
            ORCH_INTEGRATION_BRANCH: config.integrationBranch,
          },
        );
        if (!setup.ok) {
          return {
            outcome: "failed",
            error: `worktree setup failed:\n${tail(setup.output)}`,
          };
        }
      }

      const specBody = matter(fs.readFileSync(pr.specPath, "utf8")).content;
      const session = await runSession({
        cwd: dir,
        prompt: buildCoderPrompt(pr, specBody, config, attempt),
        systemAppend: CODER_RULES,
        settings: config.coders,
        session: config.session,
        logFile,
        onEvent: forwardSessionEvents(ctx, "coding"),
      });
      const { metrics } = session;

      if (session.result.subtype !== "success") {
        const detail =
          "errors" in session.result ? session.result.errors.join("; ") : "";
        return {
          outcome: "failed",
          error: `agent session ended with ${session.result.subtype}${detail ? `: ${detail}` : ""}`,
          metrics,
        };
      }
      const blocked = parseBlocked(session.finalText);
      if (blocked) {
        return {
          outcome: "failed",
          error: `BLOCKED: ${blocked}`,
          retryable: false,
          metrics,
        };
      }

      // Gate 1: the agent must have produced commits. Commit leftovers for it.
      if (!(await isClean(dir))) {
        await commitAll(dir, `${pr.id}: ${pr.title}`);
      }
      if ((await commitsAhead(dir, config.integrationBranch)) === 0) {
        return {
          outcome: "failed",
          error: "the agent finished without making any changes",
          metrics,
        };
      }

      // Gate 2: the project's own checks, run by the harness, not the agent.
      const check = await runCommand(
        config.checkCommand,
        dir,
        config.checkTimeoutMs,
      );
      if (!check.ok) {
        return {
          outcome: "failed",
          error: `check command failed (${config.checkCommand}):\n${tail(check.output)}`,
          metrics,
        };
      }

      let prUrl: string | undefined;
      let prNumber: number | undefined;
      if (remote) {
        await push(dir, branch, { expectedRemote });
      }
      if (remote && config.openPullRequests) {
        const created = await createPullRequest(dir, {
          base: config.integrationBranch,
          head: branch,
          title: `${pr.id}: ${pr.title}`,
          body: `${session.finalText.trim()}\n\nSpec: \`${path.relative(repo, pr.specPath).replaceAll("\\", "/")}\``,
        });
        prUrl = created.url;
        prNumber = created.number;
      }
      return { outcome: "pr-open", branch, prUrl, prNumber, metrics };
    } finally {
      await removeWorktree(repo, dir);
    }
  };
}
