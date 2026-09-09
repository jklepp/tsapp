// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addWorktree,
  branchExists,
  commitAll,
  commitsAhead,
  ensureBranch,
  hasRemote,
  isClean,
  removeWorktree,
  runCommand,
  tail,
} from "./git";
import { makeRepo } from "./testing";

describe("git helpers", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await makeRepo();
  });
  afterAll(() => {
    fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  });

  it("creates the integration branch once and reuses it", async () => {
    expect(await branchExists(repo, "integration")).toBe(false);
    expect(await ensureBranch(repo, "integration", "main")).toBe("created");
    expect(await ensureBranch(repo, "integration", "main")).toBe("existing");
    expect(await hasRemote(repo)).toBe(false);
  });

  it("adds a worktree, tracks commits ahead, and keeps the branch on removal", async () => {
    const dir = path.join(path.dirname(repo), "wt", "pr-a");
    await addWorktree(repo, dir, "pr/a", "integration", true);
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(await isClean(dir)).toBe(true);
    expect(await commitsAhead(dir, "integration")).toBe(0);

    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    expect(await isClean(dir)).toBe(false);
    await commitAll(dir, "pr/a: add a.txt");
    expect(await commitsAhead(dir, "integration")).toBe(1);

    await removeWorktree(repo, dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(await branchExists(repo, "pr/a")).toBe(true);

    // A retry reuses the branch and its commit; a reset starts over.
    await addWorktree(repo, dir, "pr/a", "integration", false);
    expect(await commitsAhead(dir, "integration")).toBe(1);
    await removeWorktree(repo, dir);
    await addWorktree(repo, dir, "pr/a", "integration", true);
    expect(await commitsAhead(dir, "integration")).toBe(0);
    await removeWorktree(repo, dir);
  });

  it("runs shell commands with output capture and exit status", async () => {
    const ok = await runCommand("node -e \"console.log('hi')\"", repo, 10000);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("hi");
    const bad = await runCommand(
      "node -e \"console.error('nope'); process.exit(3)\"",
      repo,
      10000,
    );
    expect(bad.ok).toBe(false);
    expect(bad.exitCode).toBe(3);
    expect(tail(bad.output)).toContain("nope");
  });
});
