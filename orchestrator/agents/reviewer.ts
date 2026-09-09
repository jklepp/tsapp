/**
 * The optional review stage, off unless `review.enabled`.
 *
 * Reviewers are read-only sessions with a repo-supplied prompt file (a
 * Claude Code agent definition works unmodified). The harness:
 *   1. checks the PR branch out in a scratch worktree and writes the diff
 *      against integration to a patch file in the run directory
 *   2. runs `review.classifyCommand` if set; it prints {"reviewers": [names]}
 *      and an empty list skips review (prose-only diffs, say)
 *   3. runs the selected reviewers concurrently, each told where the patch
 *      and the spec are, each required to end with `VERDICT: PASS` or
 *      `VERDICT: BLOCK`
 *   4. reports block with the findings, so the graph can send the PR back to
 *      a coder once, or pass
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { OrchestratorConfig, ReviewerConfig } from "../config.js";
import { addWorktree, git, removeWorktree, runCommand } from "../git.js";
import { addPhaseMetrics } from "../metrics.js";
import { branchFor, worktreeDirFor } from "../naming.js";
import type { PhaseMetrics, PrRecord } from "../state.js";
import {
  forwardSessionEvents,
  runAgentSession,
  type SessionRunner,
} from "./session.js";
import type { Reviewer, ReviewResult } from "./types.js";

export const VERDICT_FOOTER = `

## How to answer

Review only what is in the patch. Do not edit files. Report each finding on its own line with the file and line it concerns. Mark a finding BLOCKING only if the PR must not merge as it stands. End your reply with exactly one final line: \`VERDICT: PASS\` or \`VERDICT: BLOCK\`.`;

/** Prompt body from a reviewer file; frontmatter (name, tools, ...) is stripped. */
export function loadReviewerPrompt(file: string): {
  body: string;
  tools?: string[];
} {
  const { data, content } = matter(fs.readFileSync(file, "utf8"));
  const tools =
    typeof data.tools === "string"
      ? data.tools
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean)
      : Array.isArray(data.tools)
        ? (data.tools as string[])
        : undefined;
  return { body: content.trim(), tools };
}

export function reviewPrompt(
  pr: PrRecord,
  patchFile: string,
  config: OrchestratorConfig,
): string {
  return [
    `# Review PR ${pr.id}: ${pr.title}`,
    "",
    `Diff against ${config.integrationBranch}: \`${patchFile}\``,
    `Spec (the brief this PR must satisfy): \`${pr.specPath}\``,
    "The branch is checked out in your working directory if you need context beyond the diff.",
  ].join("\n");
}

/** `VERDICT: PASS|BLOCK` on its own line wins; a bare **BLOCKING** marker is the fallback. */
export function parseVerdict(text: string): "pass" | "block" {
  const m = [...text.matchAll(/^\s*VERDICT:\s*(PASS|BLOCK)\b/gim)].pop();
  if (m) return m[1].toUpperCase() === "BLOCK" ? "block" : "pass";
  return /\*\*BLOCKING\*\*/.test(text) ? "block" : "pass";
}

export interface ReviewerDeps {
  runSession?: SessionRunner;
}

export function createReviewer(deps: ReviewerDeps = {}): Reviewer {
  const runSession = deps.runSession ?? runAgentSession;

  return async (pr, ctx): Promise<ReviewResult> => {
    const { config, attempt } = ctx;
    const review = config.review;
    const repo = config.repoPath;
    const branch = pr.branch ?? branchFor(config, pr.id);
    const dir = worktreeDirFor(config, `review-${pr.id}`);
    const reviewDir = path.join(config.runsDir, ctx.runId, "review");
    fs.mkdirSync(reviewDir, { recursive: true });
    const patchFile = path.join(reviewDir, `${pr.id}-attempt${attempt}.patch`);

    await addWorktree(repo, dir, branch, branch, false);
    try {
      const patch = await git(
        ["diff", `${config.integrationBranch}...HEAD`],
        dir,
      );
      fs.writeFileSync(patchFile, patch + "\n");

      let selected: ReviewerConfig[] = review.reviewers;
      if (review.classifyCommand) {
        const out = await runCommand(
          review.classifyCommand,
          dir,
          config.checkTimeoutMs,
        );
        if (!out.ok) {
          return {
            outcome: "skipped",
            findings: `classify command failed: ${out.output.trim().split("\n").pop() ?? ""}`,
          };
        }
        const names = parseClassify(out.output);
        selected = review.reviewers.filter((r) => names.includes(r.name));
      }
      if (selected.length === 0) {
        return { outcome: "skipped", findings: "no reviewer selected" };
      }

      const settings = {
        model: review.model,
        effort: review.effort,
        maxTurns: review.maxTurns,
        maxBudgetUsd: review.maxBudgetUsd,
        allowedTools: [] as string[],
      };
      const runs = await Promise.all(
        selected.map(async (r) => {
          const prompt = loadReviewerPrompt(path.resolve(repo, r.promptFile));
          const session = await runSession({
            cwd: dir,
            prompt: reviewPrompt(pr, patchFile, config),
            systemAppend: prompt.body + VERDICT_FOOTER,
            settings: {
              ...settings,
              allowedTools: r.allowedTools ?? prompt.tools ?? [],
            },
            session: config.session,
            logFile: path.join(
              config.runsDir,
              ctx.runId,
              "logs",
              `${pr.id}-attempt${attempt}-review-${r.name}.log`,
            ),
            onEvent: forwardSessionEvents(ctx, "review"),
          });
          return { name: r.name, session };
        }),
      );

      let metrics: PhaseMetrics | undefined;
      const findings: string[] = [];
      let blocked = false;
      for (const { name, session } of runs) {
        metrics = addPhaseMetrics(metrics, session.metrics);
        const ok = session.result.subtype === "success";
        const verdict = ok ? parseVerdict(session.finalText) : "pass";
        if (verdict === "block") blocked = true;
        findings.push(
          `## ${name}: ${ok ? verdict.toUpperCase() : `session ended with ${session.result.subtype}`}\n\n${session.finalText.trim()}`,
        );
      }
      return {
        outcome: blocked ? "block" : "pass",
        findings: findings.join("\n\n"),
        metrics,
      };
    } finally {
      await removeWorktree(repo, dir);
    }
  };
}

/** Reviewer names from a classify command's JSON output (last JSON object in the output). */
export function parseClassify(output: string): string[] {
  const m = output.match(/\{[\s\S]*\}\s*$/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]) as { reviewers?: unknown };
    return Array.isArray(parsed.reviewers) ? parsed.reviewers.map(String) : [];
  } catch {
    return [];
  }
}
