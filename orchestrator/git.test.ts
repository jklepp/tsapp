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
  fastForward,
  fetch,
  git,
  hasRemote,
  isClean,
  push,
  remoteSha,
  removeWorktree,
  revParse,
  runCommand,
  syncBranch,
  tail,
  trailerValues,
} from "./git";
import { cloneOf, makeRepo, makeRepoWithRemote } from "./testing";

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

describe("remote-aware helpers", () => {
  it("fetches, fast-forwards, pins pushes to a lease, and reads trailers", async () => {
    const { repo, origin } = await makeRepoWithRemote();
    const other = await cloneOf(origin, "other");

    // Another writer advances main on the remote.
    fs.writeFileSync(path.join(other, "other.txt"), "x\n");
    await commitAll(other, "other: change\n\nOrch-Spec: other-spec");
    await git(["push", "-q", "origin", "main"], other);

    // syncBranch creates integration from the remote main when missing...
    await syncBranch(repo, "integration", "main", { fetch: true });
    expect(await revParse(repo, "integration")).toBe(
      await revParse(repo, "origin/main"),
    );
    // ...and fast-forwards a local branch that is behind.
    expect(await remoteSha(repo, "integration")).toBeUndefined();
    await git(["push", "-q", "origin", "integration"], repo);
    fs.writeFileSync(path.join(other, "more.txt"), "y\n");
    await git(["checkout", "-q", "-b", "integration", "origin/main"], other);
    await commitAll(other, "other: more");
    await git(["push", "-q", "origin", "integration"], other);
    await fetch(repo);
    expect(await fastForward(repo, "integration", "origin/integration")).toBe(
      "moved",
    );
    expect(await fastForward(repo, "integration", "origin/integration")).toBe(
      "unchanged",
    );
    expect(await trailerValues(repo, "integration", "Orch-Spec")).toEqual(
      new Set(["other-spec"]),
    );

    // A pinned lease refuses to overwrite a remote branch that moved.
    const wt = path.join(path.dirname(repo), "wt", "lease");
    await addWorktree(repo, wt, "pr/lease", "integration", true);
    fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
    await commitAll(wt, "a");
    await push(wt, "pr/lease", { expectedRemote: null }); // must not exist yet
    const seen = await remoteSha(repo, "pr/lease");
    // Someone else force-pushes the branch.
    await git(
      ["push", "-q", "-f", "origin", "integration:refs/heads/pr/lease"],
      other,
    );
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    await commitAll(wt, "b");
    await fetch(repo);
    await expect(
      push(wt, "pr/lease", { expectedRemote: seen }),
    ).rejects.toThrow(/rejected|stale|lease/i);
    await removeWorktree(repo, wt);
    fs.rmSync(path.dirname(origin), { recursive: true, force: true });
  });

  it("refuses to fast-forward a branch checked out in another worktree or diverged", async () => {
    const { repo, origin } = await makeRepoWithRemote();
    await git(["branch", "integration", "main"], repo);
    const wt = path.join(path.dirname(repo), "wt", "i");
    await addWorktree(repo, wt, "integration", "integration", false);
    await git(["push", "-q", "origin", "integration"], repo);
    const other = await cloneOf(origin, "other2");
    await git(["checkout", "-q", "integration"], other);
    fs.writeFileSync(path.join(other, "z.txt"), "z\n");
    await commitAll(other, "z");
    await git(["push", "-q", "origin", "integration"], other);
    await fetch(repo);
    await expect(
      fastForward(repo, "integration", "origin/integration"),
    ).rejects.toThrow(/checked out/);
    await removeWorktree(repo, wt);
    // Diverged: local integration gets its own commit.
    const wt2 = path.join(path.dirname(repo), "wt", "i2");
    await addWorktree(repo, wt2, "integration", "integration", false);
    fs.writeFileSync(path.join(wt2, "local.txt"), "l\n");
    await commitAll(wt2, "local");
    await removeWorktree(repo, wt2);
    await expect(
      fastForward(repo, "integration", "origin/integration"),
    ).rejects.toThrow(/diverged/);
    fs.rmSync(path.dirname(origin), { recursive: true, force: true });
  });
});
