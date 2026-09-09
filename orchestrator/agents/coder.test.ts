// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { OrchestratorConfigSchema, resolvePaths } from "../config";
import { branchExists, commitAll, commitsAhead, git } from "../git";
import { makeRepo } from "../testing";
import type { PrRecord } from "../state";
import { buildCoderPrompt, createCoder, parseBlocked } from "./coder";
import type { SessionRequest, SessionRunner } from "./session";
import { fakeMetrics } from "./stub";

/** A fake agent: runs `act` inside the worktree, then "says" `finalText`. */
const fakeSession =
  (
    act: (cwd: string) => Promise<void> | void,
    finalText = "Implemented and tested.",
    subtype: SDKResultMessage["subtype"] = "success",
  ): SessionRunner =>
  async (req: SessionRequest) => {
    await act(req.cwd);
    fs.mkdirSync(path.dirname(req.logFile), { recursive: true });
    fs.writeFileSync(req.logFile, "fake transcript\n");
    return {
      result: { subtype, errors: ["fake"] } as unknown as SDKResultMessage,
      metrics: fakeMetrics(new Date()),
      finalText,
    };
  };

describe("coder", () => {
  let repo: string;
  let root: string;
  let config: ReturnType<typeof OrchestratorConfigSchema.parse>;
  let pr: PrRecord;

  beforeAll(async () => {
    repo = await makeRepo();
    root = path.dirname(repo);
    // The project's "check": pass only when ok.txt exists.
    fs.writeFileSync(
      path.join(repo, "check.js"),
      "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)",
    );
    fs.mkdirSync(path.join(repo, "specs"));
    fs.writeFileSync(
      path.join(repo, "specs", "a.md"),
      "---\nid: a\ntitle: Add ok.txt\n---\nCreate ok.txt containing ok.\n",
    );
    await commitAll(repo, "add check and spec");
    config = resolvePaths(
      OrchestratorConfigSchema.parse({
        repoPath: repo,
        specsDir: path.join(repo, "specs"),
        runsDir: path.join(root, "runs"),
        worktreesDir: path.join(root, "wt"),
        checkCommand: "node check.js",
        linkNodeModules: false,
      }),
      root,
    );
    pr = {
      id: "a",
      title: "Add ok.txt",
      specPath: path.join(repo, "specs", "a.md"),
      priority: 3,
      dependsOn: [],
      touches: [],
      status: "coding",
      attempts: 1,
    };
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ctx = (attempt = 1) => ({ config, runId: "test-run", attempt });

  it("builds a prompt with the spec, and feedback only on retries", () => {
    const first = buildCoderPrompt(pr, "Do X.", config, 1);
    expect(first).toContain("# PR a: Add ok.txt");
    expect(first).toContain("node check.js");
    expect(first).toContain("Do X.");
    expect(first).not.toContain("Previous attempt");
    const retry = buildCoderPrompt(
      { ...pr, error: "check failed" },
      "Do X.",
      config,
      2,
    );
    expect(retry).toContain("Previous attempt (1) failed");
    expect(retry).toContain("check failed");
  });

  it("detects BLOCKED replies", () => {
    expect(parseBlocked("BLOCKED: spec contradicts itself")).toBe(
      "spec contradicts itself",
    );
    expect(parseBlocked("All done.\nBLOCKED: nope")).toBe("nope");
    expect(parseBlocked("I was blocked for a while but finished.")).toBe(
      undefined,
    );
  });

  it("opens a PR when the agent commits and checks pass", async () => {
    const coder = createCoder({
      runSession: fakeSession(async (cwd) => {
        fs.writeFileSync(path.join(cwd, "ok.txt"), "ok\n");
        await commitAll(cwd, "a: Add ok.txt");
      }),
    });
    const result = await coder(pr, ctx());
    expect(result.outcome).toBe("pr-open");
    if (result.outcome !== "pr-open") return;
    expect(result.branch).toBe("pr/a");
    expect(result.prUrl).toBeUndefined(); // no remote
    expect(result.metrics.inputTokens).toBe(4000);
    expect(await branchExists(repo, "integration")).toBe(true);
    expect(await commitsAhead(repo, "integration")).toBe(0); // main untouched
    expect(await git(["rev-list", "--count", "integration..pr/a"], repo)).toBe(
      "1",
    );
    expect(fs.existsSync(path.join(config.worktreesDir, "a"))).toBe(false);
    expect(
      fs.existsSync(
        path.join(config.runsDir, "test-run", "logs", "a-attempt1-coder.log"),
      ),
    ).toBe(true);
  });

  it("commits on the agent's behalf when it forgets", async () => {
    const coder = createCoder({
      runSession: fakeSession((cwd) => {
        fs.writeFileSync(path.join(cwd, "ok.txt"), "ok\n");
      }),
    });
    const result = await coder(pr, ctx());
    expect(result.outcome).toBe("pr-open");
    const msg = await git(["log", "-1", "--format=%s", "pr/a"], repo);
    expect(msg).toBe("a: Add ok.txt");
  });

  it("fails with check output when the project's checks fail", async () => {
    const coder = createCoder({
      runSession: fakeSession((cwd) => {
        fs.writeFileSync(path.join(cwd, "wrong.txt"), "x\n");
      }),
    });
    const result = await coder(pr, ctx());
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.error).toContain("check command failed");
    expect(result.retryable).toBeUndefined();
  });

  it("fails when the agent changes nothing", async () => {
    const coder = createCoder({ runSession: fakeSession(() => {}) });
    const result = await coder(pr, ctx());
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed")
      expect(result.error).toContain("without making any changes");
  });

  it("marks BLOCKED specs as not retryable", async () => {
    const coder = createCoder({
      runSession: fakeSession(() => {}, "BLOCKED: file does not exist"),
    });
    const result = await coder(pr, ctx());
    expect(result).toMatchObject({
      outcome: "failed",
      retryable: false,
      error: "BLOCKED: file does not exist",
    });
  });

  it("reports a session that hit a cap", async () => {
    const coder = createCoder({
      runSession: fakeSession(() => {}, "", "error_max_turns"),
    });
    const result = await coder(pr, ctx());
    expect(result).toMatchObject({ outcome: "failed" });
    if (result.outcome === "failed")
      expect(result.error).toContain("error_max_turns");
  });

  it("continues on the same branch for a retry", async () => {
    // Attempt 1 leaves a failing commit on pr/a.
    const first = createCoder({
      runSession: fakeSession(async (cwd) => {
        fs.writeFileSync(path.join(cwd, "partial.txt"), "wip\n");
        await commitAll(cwd, "wip");
      }),
    });
    expect((await first(pr, ctx(1))).outcome).toBe("failed");
    // Attempt 2 sees partial.txt and finishes the job.
    let sawPartial = false;
    const second = createCoder({
      runSession: fakeSession(async (cwd) => {
        sawPartial = fs.existsSync(path.join(cwd, "partial.txt"));
        fs.writeFileSync(path.join(cwd, "ok.txt"), "ok\n");
        await commitAll(cwd, "finish");
      }),
    });
    const result = await second({ ...pr, attempts: 2, error: "x" }, ctx(2));
    expect(sawPartial).toBe(true);
    expect(result.outcome).toBe("pr-open");
    expect(await git(["rev-list", "--count", "integration..pr/a"], repo)).toBe(
      "2",
    );
  });
});

describe("coder naming from config", () => {
  it("uses branchPrefix and worktreeNamePrefix", async () => {
    const repo = await makeRepo();
    const root = path.dirname(repo);
    fs.writeFileSync(path.join(repo, "check.js"), "process.exit(0)");
    fs.mkdirSync(path.join(repo, "specs"));
    fs.writeFileSync(
      path.join(repo, "specs", "n.md"),
      "---\nid: n\ntitle: N\n---\nbody\n",
    );
    await commitAll(repo, "seed");
    const cfg = resolvePaths(
      OrchestratorConfigSchema.parse({
        repoPath: repo,
        specsDir: path.join(repo, "specs"),
        runsDir: path.join(root, "runs"),
        worktreesDir: path.join(root, "wt"),
        checkCommand: "node check.js",
        linkNodeModules: false,
        branchPrefix: "orch",
        worktreeNamePrefix: "orch-",
      }),
      root,
    );
    let seenDir = "";
    const coder = createCoder({
      runSession: fakeSession(async (cwd) => {
        seenDir = cwd;
        fs.writeFileSync(path.join(cwd, "n.txt"), "n\n");
        await commitAll(cwd, "n: done");
      }),
    });
    const record: PrRecord = {
      id: "n",
      title: "N",
      specPath: path.join(repo, "specs", "n.md"),
      priority: 3,
      dependsOn: [],
      touches: [],
      status: "coding",
      attempts: 1,
    };
    const result = await coder(record, { config: cfg, runId: "r", attempt: 1 });
    expect(result.outcome).toBe("pr-open");
    if (result.outcome === "pr-open") expect(result.branch).toBe("orch/n");
    expect(path.basename(seenDir)).toBe("orch-n");
    expect(await branchExists(repo, "orch/n")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
