// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { OrchestratorConfigSchema, resolvePaths } from "../config";
import { addWorktree, commitAll, git, removeWorktree } from "../git";
import type { PrRecord } from "../state";
import { makeRepo } from "../testing";
import {
  createReviewer,
  loadReviewerPrompt,
  parseClassify,
  parseVerdict,
} from "./reviewer";
import type { SessionRequest, SessionRunner } from "./session";
import { fakeMetrics } from "./stub";

describe("parseVerdict", () => {
  it("uses the last VERDICT line, else a BLOCKING marker, else pass", () => {
    expect(parseVerdict("stuff\nVERDICT: PASS")).toBe("pass");
    expect(parseVerdict("VERDICT: PASS\n...\nverdict: block")).toBe("block");
    expect(parseVerdict("- **BLOCKING** foo.ts:3 bad")).toBe("block");
    expect(parseVerdict("looks fine")).toBe("pass");
  });
});

describe("parseClassify", () => {
  it("reads the trailing JSON object", () => {
    expect(
      parseClassify('noise\n{"reviewers":["spec","standards"]}\n'),
    ).toEqual(["spec", "standards"]);
    expect(parseClassify('{"reviewers":[]}')).toEqual([]);
    expect(parseClassify("not json")).toEqual([]);
  });
});

describe("createReviewer", () => {
  let repo: string;
  let root: string;
  let pr: PrRecord;
  const specPath = () => path.join(repo, "specs", "a.md");

  beforeAll(async () => {
    repo = await makeRepo();
    root = path.dirname(repo);
    fs.mkdirSync(path.join(repo, "specs"));
    fs.writeFileSync(specPath(), "---\nid: a\ntitle: A\n---\nDo A.\n");
    fs.mkdirSync(path.join(repo, "agents"));
    fs.writeFileSync(
      path.join(repo, "agents", "spec.md"),
      "---\nname: spec-reviewer\ntools: Read, Grep\n---\nCheck the diff does what the brief asks.\n",
    );
    fs.writeFileSync(
      path.join(repo, "agents", "standards.md"),
      "Check style.\n",
    );
    await commitAll(repo, "seed");
    await git(["branch", "integration", "main"], repo);
    const wt = path.join(root, "wt", "a");
    await addWorktree(repo, wt, "pr/a", "integration", true);
    fs.writeFileSync(path.join(wt, "a.txt"), "hello\n");
    await commitAll(wt, "a: add a.txt");
    await removeWorktree(repo, wt);
    pr = {
      id: "a",
      title: "A",
      specPath: specPath(),
      priority: 3,
      dependsOn: [],
      touches: [],
      status: "pr-open",
      attempts: 1,
      branch: "pr/a",
    };
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const config = (review: Record<string, unknown>) =>
    resolvePaths(
      OrchestratorConfigSchema.parse({
        repoPath: repo,
        specsDir: path.join(repo, "specs"),
        runsDir: path.join(root, "runs"),
        worktreesDir: path.join(root, "wt"),
        linkNodeModules: false,
        review: {
          enabled: true,
          reviewers: [
            { name: "spec", promptFile: "agents/spec.md" },
            { name: "standards", promptFile: "agents/standards.md" },
          ],
          ...review,
        },
      }),
      root,
    );

  const session = (
    reply: (req: SessionRequest) => string,
  ): { runner: SessionRunner; calls: SessionRequest[] } => {
    const calls: SessionRequest[] = [];
    const runner: SessionRunner = async (req) => {
      calls.push(req);
      fs.mkdirSync(path.dirname(req.logFile), { recursive: true });
      fs.writeFileSync(req.logFile, "fake\n");
      return {
        result: { subtype: "success" } as unknown as SDKResultMessage,
        metrics: fakeMetrics(new Date(), 0.1),
        finalText: reply(req),
      };
    };
    return { runner, calls };
  };

  it("runs every configured reviewer with the patch, prompt body and tools", async () => {
    const { runner, calls } = session((req) =>
      req.systemAppend.startsWith("Check the diff")
        ? "- fine\nVERDICT: PASS"
        : "VERDICT: PASS",
    );
    const cfg = config({});
    const result = await createReviewer({ runSession: runner })(pr, {
      config: cfg,
      runId: "r",
      attempt: 1,
    });
    expect(result.outcome).toBe("pass");
    expect(calls).toHaveLength(2);
    const spec = calls.find((c) =>
      c.systemAppend.startsWith("Check the diff"),
    )!;
    expect(spec.settings.allowedTools).toEqual(["Read", "Grep", "Glob"]); // config default wins
    expect(spec.systemAppend).toContain("VERDICT: PASS");
    expect(spec.prompt).toContain("a-attempt1.patch");
    const patch = fs.readFileSync(
      path.join(cfg.runsDir, "r", "review", "a-attempt1.patch"),
      "utf8",
    );
    expect(patch).toContain("+hello");
    expect(result.metrics?.costUsd).toBeCloseTo(0.05, 5);
    expect(fs.existsSync(path.join(cfg.worktreesDir, "review-a"))).toBe(false);
  });

  it("blocks when any reviewer blocks, and carries the findings", async () => {
    const { runner } = session((req) =>
      req.systemAppend.startsWith("Check style")
        ? "- **BLOCKING** a.txt:1 no newline policy\nVERDICT: BLOCK"
        : "VERDICT: PASS",
    );
    const result = await createReviewer({ runSession: runner })(pr, {
      config: config({}),
      runId: "r",
      attempt: 1,
    });
    expect(result.outcome).toBe("block");
    expect(result.findings).toContain("## standards: BLOCK");
    expect(result.findings).toContain("no newline policy");
    expect(result.findings).toContain("## spec: PASS");
  });

  it("selects reviewers from classifyCommand and skips when none apply", async () => {
    const { runner, calls } = session(() => "VERDICT: PASS");
    const only = await createReviewer({ runSession: runner })(pr, {
      config: config({
        classifyCommand: `node -e "console.log(JSON.stringify({reviewers:['spec']}))"`,
      }),
      runId: "r",
      attempt: 1,
    });
    expect(only.outcome).toBe("pass");
    expect(calls).toHaveLength(1);
    const none = await createReviewer({ runSession: runner })(pr, {
      config: config({
        classifyCommand: `node -e "console.log(JSON.stringify({reviewers:[]}))"`,
      }),
      runId: "r",
      attempt: 1,
    });
    expect(none.outcome).toBe("skipped");
    expect(calls).toHaveLength(1);
  });

  it("reads tools from prompt frontmatter", () => {
    const p = loadReviewerPrompt(path.join(repo, "agents", "spec.md"));
    expect(p.tools).toEqual(["Read", "Grep"]);
    expect(p.body).toBe("Check the diff does what the brief asks.");
  });
});
