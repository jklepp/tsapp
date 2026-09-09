/**
 * Thin wrappers over git, gh and shell commands. No model involvement; every
 * function here is deterministic and cheap, which is why the harness (not the
 * agent) owns branching, pushing and PR creation.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${e.stderr?.trim() || e.message}`,
      { cause: err },
    );
  }
}

export async function branchExists(repo: string, name: string) {
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], repo);
    return true;
  } catch {
    return false;
  }
}

export async function hasRemote(repo: string, remote = "origin") {
  const remotes = await git(["remote"], repo);
  return remotes.split(/\r?\n/).includes(remote);
}

/** Create `name` from `from` if it does not exist. Never resets an existing branch. */
export async function ensureBranch(
  repo: string,
  name: string,
  from: string,
): Promise<"created" | "existing"> {
  if (await branchExists(repo, name)) return "existing";
  await git(["branch", name, from], repo);
  return "created";
}

/**
 * Check out `branch` in its own worktree at `dir`. With `reset`, the branch is
 * (re)created from `from`; without it an existing branch is reused so a retry
 * continues from the previous attempt's commits instead of starting over.
 */
export async function addWorktree(
  repo: string,
  dir: string,
  branch: string,
  from: string,
  reset: boolean,
): Promise<void> {
  await removeWorktree(repo, dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (reset || !(await branchExists(repo, branch))) {
    await git(["worktree", "add", "-B", branch, dir, from], repo);
  } else {
    await git(["worktree", "add", dir, branch], repo);
  }
}

export async function removeWorktree(repo: string, dir: string) {
  if (fs.existsSync(dir)) {
    try {
      await git(["worktree", "remove", "--force", dir], repo);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  await git(["worktree", "prune"], repo);
}

/** Link the repo's node_modules into a worktree so no install is needed. */
export function linkNodeModules(repo: string, dir: string) {
  const source = path.join(repo, "node_modules");
  const target = path.join(dir, "node_modules");
  if (fs.existsSync(source) && !fs.existsSync(target)) {
    fs.symlinkSync(source, target, "junction");
  }
}

export async function commitsAhead(cwd: string, base: string) {
  return Number(await git(["rev-list", "--count", `${base}..HEAD`], cwd));
}

export async function isClean(cwd: string) {
  return (await git(["status", "--porcelain"], cwd)) === "";
}

export async function commitAll(cwd: string, message: string) {
  await git(["add", "-A"], cwd);
  await git(["commit", "-m", message], cwd);
}

export async function push(cwd: string, branch: string, remote = "origin") {
  await git(["push", "--force-with-lease", "-u", remote, branch], cwd);
}

export interface PullRequestInfo {
  url: string;
  number?: number;
}

export async function createPullRequest(
  cwd: string,
  opts: { base: string; head: string; title: string; body: string },
): Promise<PullRequestInfo> {
  const bodyFile = path.join(cwd, ".pr-body.tmp.md");
  fs.writeFileSync(bodyFile, opts.body);
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "create",
        "--base",
        opts.base,
        "--head",
        opts.head,
        "--title",
        opts.title,
        "--body-file",
        bodyFile,
      ],
      { cwd },
    );
    const url = stdout.trim().split(/\s+/).pop() ?? "";
    const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
    return { url, number: Number.isFinite(number) ? number : undefined };
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

/** Run a shell command (e.g. the project's check command) and capture its output. */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    child.stdout.on("data", (d) => chunks.push(String(d)));
    child.stderr.on("data", (d) => chunks.push(String(d)));
    const timer = setTimeout(() => {
      child.kill();
      chunks.push(`\n[timed out after ${timeoutMs} ms]`);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, output: chunks.join("") });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, output: err.message });
    });
  });
}

/** Last `lines` lines of a command's output, for error feedback. */
export function tail(output: string, lines = 40): string {
  return output.trim().split(/\r?\n/).slice(-lines).join("\n");
}
