// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { OrchestratorConfigSchema, resolvePaths } from "../config";
import {
  addWorktree,
  commitAll,
  git,
  removeWorktree,
  revParse,
  unmergedFiles,
} from "../git";
import { makeRepo } from "../testing";
import type { PrRecord } from "../state";
import { createIntegrator } from "./integrator";
import type { SessionRequest, SessionRunner } from "./session";
import { fakeMetrics } from "./stub";

const fakeSession = (
  act: (cwd: string, req: SessionRequest) => Promise<void> | void,
  finalText = "Resolved.",
): { runner: SessionRunner; calls: SessionRequest[] } => {
  const calls: SessionRequest[] = [];
  const runner: SessionRunner = async (req) => {
    calls.push(req);
    await act(req.cwd, req);
    fs.mkdirSync(path.dirname(req.logFile), { recursive: true });
    fs.writeFileSync(req.logFile, "fake transcript\n");
    return {
      result: { subtype: "success" } as unknown as SDKResultMessage,
      metrics: fakeMetrics(new Date(), 0.5),
      finalText,
    };
  };
  return { runner, calls };
};

describe("integrator", () => {
  let repo: string;
  let root: string;
  let config: ReturnType<typeof OrchestratorConfigSchema.parse>;

  /** Commit files on a fresh pr/<id> branch cut from `from`. */
  async function prBranch(
    id: string,
    files: Record<string, string>,
    from = "integration",
  ) {
    const dir = path.join(root, "wt", id);
    await addWorktree(repo, dir, `pr/${id}`, from, true);
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    await commitAll(dir, `${id}: change`);
    await removeWorktree(repo, dir);
  }

  /** Commit directly on integration, simulating earlier merges. */
  async function onIntegration(files: Record<string, string>, msg: string) {
    const dir = path.join(root, "wt", "_seed");
    await addWorktree(repo, dir, "integration", "integration", false);
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    await commitAll(dir, msg);
    await removeWorktree(repo, dir);
  }

  const pr = (id: string): PrRecord => ({
    id,
    title: `PR ${id}`,
    specPath: path.join(repo, "specs", "a.md"),
    priority: 3,
    dependsOn: [],
    touches: [],
    status: "integrating",
    attempts: 1,
    branch: `pr/${id}`,
  });
  const ctx = { runId: "test-run", attempt: 1 };

  beforeAll(async () => {
    repo = await makeRepo();
    root = path.dirname(repo);
    // The project's "check": fail if broken.txt exists or any conflict marker survives.
    fs.writeFileSync(
      path.join(repo, "check.js"),
      [
        "const fs = require('fs');",
        "if (fs.existsSync('broken.txt')) process.exit(1);",
        "for (const f of fs.readdirSync('.')) {",
        "  if (f.endsWith('.txt') || f.endsWith('.md')) {",
        "    if (fs.readFileSync(f, 'utf8').includes('<<<<<<<')) process.exit(2);",
        "  }",
        "}",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(repo, "specs"));
    fs.writeFileSync(
      path.join(repo, "specs", "a.md"),
      "---\nid: a\ntitle: A\n---\nMake README say hello.\n",
    );
    await commitAll(repo, "add check and spec");
    await git(["branch", "integration", "main"], repo);
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
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("merges a clean branch without starting a session", async () => {
    await prBranch("clean", { "clean.txt": "ok\n" });
    const { runner, calls } = fakeSession(() => {});
    const result = await createIntegrator({ runSession: runner })(pr("clean"), {
      ...ctx,
      config,
    });
    expect(result.outcome).toBe("merged");
    if (result.outcome !== "merged") return;
    expect(calls).toHaveLength(0);
    expect(result.metrics.costUsd).toBe(0);
    expect(result.metrics.model).toBe("none");
    const parents = await git(
      ["log", "-1", "--format=%P", "integration"],
      repo,
    );
    expect(parents.split(" ")).toHaveLength(2); // a real merge commit
    expect(fs.existsSync(path.join(config.worktreesDir, "_integration"))).toBe(
      false,
    );
  });

  it("treats an already merged branch as merged", async () => {
    const before = await revParse(repo, "integration");
    const result = await createIntegrator({
      runSession: fakeSession(() => {}).runner,
    })(pr("clean"), { ...ctx, config });
    expect(result.outcome).toBe("merged");
    expect(await revParse(repo, "integration")).toBe(before);
  });

  it("lets a session resolve a conflict, then verifies and commits", async () => {
    await onIntegration({ "README.md": "# integration says hi\n" }, "seed");
    await prBranch("conflict", { "README.md": "# pr says hello\n" }, "main");
    const { runner, calls } = fakeSession(async (cwd, req) => {
      expect(req.prompt).toContain("README.md");
      expect(req.prompt).toContain("Make README say hello.");
      fs.writeFileSync(path.join(cwd, "README.md"), "# both: hi and hello\n");
      await git(["add", "README.md"], cwd);
      // Deliberately do not commit: the harness should complete the merge.
    });
    const result = await createIntegrator({ runSession: runner })(
      pr("conflict"),
      { ...ctx, config },
    );
    expect(result.outcome).toBe("merged");
    if (result.outcome !== "merged") return;
    expect(calls).toHaveLength(1);
    expect(result.metrics.costUsd).toBeGreaterThan(0);
    expect(await git(["show", "integration:README.md"], repo)).toBe(
      "# both: hi and hello",
    );
  });

  it("rejects and resets integration when conflicts stay unresolved", async () => {
    await prBranch("stuck", { "README.md": "# stuck version\n" }, "main");
    const before = await revParse(repo, "integration");
    const result = await createIntegrator({
      runSession: fakeSession(() => {}).runner,
    })(pr("stuck"), { ...ctx, config });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.error).toContain("unresolved conflicts in README.md");
    expect(await revParse(repo, "integration")).toBe(before);
    // The next worktree on integration must start clean.
    const dir = path.join(root, "wt", "_probe");
    await addWorktree(repo, dir, "integration", "integration", false);
    expect(await unmergedFiles(dir)).toEqual([]);
    await removeWorktree(repo, dir);
  });

  it("rejects when the agent says BLOCKED", async () => {
    const before = await revParse(repo, "integration");
    const result = await createIntegrator({
      runSession: fakeSession(() => {}, "BLOCKED: incompatible").runner,
    })(pr("stuck"), { ...ctx, config });
    expect(result).toMatchObject({ outcome: "rejected" });
    if (result.outcome === "rejected")
      expect(result.error).toContain("incompatible");
    expect(await revParse(repo, "integration")).toBe(before);
  });

  it("lets a session fix checks broken by a clean merge", async () => {
    await prBranch("breaks", { "broken.txt": "x\n" });
    const { runner, calls } = fakeSession(async (cwd, req) => {
      expect(req.prompt).toContain("Fix the checks after merging");
      fs.rmSync(path.join(cwd, "broken.txt"));
    });
    const result = await createIntegrator({ runSession: runner })(
      pr("breaks"),
      { ...ctx, config },
    );
    expect(result.outcome).toBe("merged");
    expect(calls).toHaveLength(1);
    const msg = await git(["log", "-1", "--format=%s", "integration"], repo);
    expect(msg).toBe("Fix checks after merging pr/breaks");
  });

  it("rejects and resets when checks still fail after the fix session", async () => {
    await prBranch("stillbroken", { "broken.txt": "y\n" });
    const before = await revParse(repo, "integration");
    const result = await createIntegrator({
      runSession: fakeSession(() => {}).runner,
    })(pr("stillbroken"), { ...ctx, config });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected")
      expect(result.error).toContain("checks fail after merging");
    expect(await revParse(repo, "integration")).toBe(before);
  });
});
