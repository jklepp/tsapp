/** Helpers shared by tests. Not used at runtime. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitAll, git } from "./git.js";

/** A throwaway git repo with one commit on main, inside a fresh temp dir. */
export async function makeRepo(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-git-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "Test"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
  await commitAll(repo, "initial");
  return repo;
}

/**
 * A repo whose `origin` is a bare repository in the same temp dir, with
 * `main` pushed. Lets tests exercise fetch, lease-pinned pushes and landing
 * without touching GitHub (gh itself is never invoked).
 */
export async function makeRepoWithRemote(): Promise<{
  repo: string;
  origin: string;
}> {
  const repo = await makeRepo();
  const origin = path.join(path.dirname(repo), "origin.git");
  await git(["init", "-q", "--bare", "-b", "main", origin], path.dirname(repo));
  await git(["remote", "add", "origin", origin], repo);
  await git(["push", "-q", "-u", "origin", "main"], repo);
  return { repo, origin };
}

/** Second clone of the same origin, for simulating another writer. */
export async function cloneOf(origin: string, name: string): Promise<string> {
  const dir = path.join(path.dirname(origin), name);
  await git(["clone", "-q", origin, dir], path.dirname(origin));
  await git(["config", "user.email", "other@example.com"], dir);
  await git(["config", "user.name", "Other"], dir);
  return dir;
}
