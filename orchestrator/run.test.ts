// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubCoder, stubIntegrator } from "./agents/stub";
import { OrchestratorConfigSchema, resolvePaths } from "./config";
import { addWorktree, commitAll, git, removeWorktree } from "./git";
import { runOrchestrator } from "./run";
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
  });
});
