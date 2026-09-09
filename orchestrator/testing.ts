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
