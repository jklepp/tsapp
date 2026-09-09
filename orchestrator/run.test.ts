// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubCoder, stubIntegrator } from "./agents/stub";
import type { Coder } from "./agents/types";
import { OrchestratorConfigSchema, resolvePaths } from "./config";
import { addWorktree, commitAll, git, removeWorktree } from "./git";
import {
  getRunState,
  latestRunId,
  resumeOrchestrator,
  runOrchestrator,
} from "./run";
import { makeRepo } from "./testing";

describe("runOrchestrator", () => {
  let repo: string;
  let root: string;
  let config: ReturnType<typeof OrchestratorConfigSchema.parse>;

  beforeAll(async () => {
    repo = await makeRepo();
    root = path.dirname(repo);
    fs.mkdirSync(path.join(repo, "specs"));
    for (const id of ["a", "b"]) {
      fs.writeFileSync(
        path.join(repo, "specs", `${id}.md`),
        `---\nid: ${id}\ntitle: ${id}\n---\nbody\n`,
      );
    }
    fs.writeFileSync(
      path.join(repo, "specs", "c.md"),
      "---\nid: c\ntitle: c\ndepends_on: [b]\n---\nbody\n",
    );
    await commitAll(repo, "specs");
    // Simulate an earlier run that merged pr/a into integration.
    await git(["branch", "integration", "main"], repo);
    const wt = path.join(root, "wt", "a");
    await addWorktree(repo, wt, "pr/a", "integration", true);
    fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
    await commitAll(wt, "a: done");
    await removeWorktree(repo, wt);
    const iw = path.join(root, "wt", "_i");
    await addWorktree(repo, iw, "integration", "integration", false);
    await git(["merge", "--no-ff", "-m", "Merge pr/a", "pr/a"], iw);
    await removeWorktree(repo, iw);
    config = resolvePaths(
      OrchestratorConfigSchema.parse({
        repoPath: repo,
        specsDir: path.join(repo, "specs"),
        runsDir: path.join(root, "runs"),
        worktreesDir: path.join(root, "wt"),
      }),
      root,
    );
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips specs already merged into integration and writes a summary", async () => {
    const lines: string[] = [];
    const summary = await runOrchestrator(config, {
      coder: stubCoder({ delayMs: 5 }),
      integrator: stubIntegrator({ delayMs: 5 }),
      runId: "run-1",
      onLog: (l) => lines.push(l),
    });
    expect(lines[0]).toContain("already merged, skipping: a");
    expect(lines.some((l) => l.startsWith("wave: b"))).toBe(true);
    expect(lines.some((l) => l.includes("wave: a"))).toBe(false);
    const rows = Object.fromEntries(summary.rows.map((r) => [r.id, r]));
    expect(rows.a).toMatchObject({ status: "merged", attempts: 0, costUsd: 0 });
    expect(rows.b).toMatchObject({ status: "merged", attempts: 1 });
    expect(
      fs.existsSync(path.join(config.runsDir, "run-1", "summary.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(config.runsDir, "run-1", "checkpoints.sqlite")),
    ).toBe(true);
    const status = await getRunState(config, "run-1");
    expect(status.next).toEqual([]);
    expect(status.prs.c.status).toBe("merged");
  });

  it("resumes an interrupted run from its last checkpoint", async () => {
    // Crash while c (which depends on b) is being coded, after b has merged.
    const controller = new AbortController();
    const firstRunCalls: string[] = [];
    const crashOnC: Coder = async (pr, ctx) => {
      firstRunCalls.push(pr.id);
      if (pr.id === "c") {
        controller.abort();
        await new Promise((r) => setTimeout(r, 300));
      }
      return stubCoder({ delayMs: 5 })(pr, ctx);
    };
    await expect(
      runOrchestrator(config, {
        coder: crashOnC,
        integrator: stubIntegrator({ delayMs: 5 }),
        runId: "run-2",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(firstRunCalls).toEqual(["b", "c"]);

    // The checkpoint remembers b merged and c in flight.
    const status = await getRunState(config, "run-2");
    expect(status.prs.b.status).toBe("merged");
    expect(status.prs.c.status).toBe("coding");
    expect(status.next).toEqual(["code"]);
    expect(latestRunId(config)).toBe("run-2");

    // Resume: only c is coded again; b is not touched.
    const resumeCalls: string[] = [];
    const lines: string[] = [];
    const summary = await resumeOrchestrator(config, "run-2", {
      coder: async (pr, ctx) => {
        resumeCalls.push(pr.id);
        return stubCoder({ delayMs: 5 })(pr, ctx);
      },
      integrator: stubIntegrator({ delayMs: 5 }),
      onLog: (l) => lines.push(l),
    });
    expect(lines[0]).toContain("resuming run run-2");
    expect(lines[0]).toContain("next: code");
    expect(resumeCalls).toEqual(["c"]);
    const rows = Object.fromEntries(summary.rows.map((r) => [r.id, r]));
    expect(rows.b).toMatchObject({ status: "merged", attempts: 1 });
    expect(rows.c).toMatchObject({ status: "merged", attempts: 1 });
    expect((await getRunState(config, "run-2")).next).toEqual([]);
  });
});
