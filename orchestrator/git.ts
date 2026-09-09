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

/**
 * Push a branch. PR branches are force-pushed (with lease) because a retry
 * may rewrite them; the integration branch is only ever fast-forwarded.
 */
export async function push(
  cwd: string,
  branch: string,
  opts: {
    remote?: string;
    force?: boolean;
    expectedRemote?: string | null;
  } = {},
) {
  const { remote = "origin", force = true, expectedRemote } = opts;
  const args = ["push", "-u", remote, branch];
  if (expectedRemote !== undefined) {
    // Pinned lease: succeed only if the remote branch is exactly where we
    // last saw it (null = must not exist). A bare --force-with-lease would
    // bless whatever a fresh fetch happened to bring in.
    args.splice(1, 0, `--force-with-lease=${branch}:${expectedRemote ?? ""}`);
  } else if (force) {
    args.splice(1, 0, "--force-with-lease");
  }
  await git(args, cwd);
}

export async function fetch(repo: string, remote = "origin") {
  await git(["fetch", "--prune", remote], repo);
}

/** Sha of the remote-tracking ref, or undefined when the remote has no such branch. */
export async function remoteSha(
  repo: string,
  branch: string,
  remote = "origin",
): Promise<string | undefined> {
  try {
    return await git(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`],
      repo,
    );
  } catch {
    return undefined;
  }
}

/** Worktree path that has `branch` checked out, if any. */
export async function worktreeOf(
  repo: string,
  branch: string,
): Promise<string | undefined> {
  const out = await git(["worktree", "list", "--porcelain"], repo);
  let current: string | undefined;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return undefined;
}

/**
 * Move `branch` forward to `ref` if that is a fast-forward. Refuses when the
 * branch is checked out in some other worktree (two writers) or has diverged.
 */
export async function fastForward(repo: string, branch: string, ref: string) {
  const target = await git(["rev-parse", "--verify", ref], repo);
  const current = await git(["rev-parse", "--verify", branch], repo);
  if (current === target) return "unchanged" as const;
  const ancestor = await isAncestor(repo, branch, ref);
  if (!ancestor) {
    throw new Error(
      `${branch} has diverged from ${ref}; refusing to move it. Reconcile by hand.`,
    );
  }
  const where = await worktreeOf(repo, branch);
  if (where) {
    const main = await git(["rev-parse", "--show-toplevel"], repo);
    if (path.resolve(where) !== path.resolve(main)) {
      throw new Error(
        `${branch} is checked out in ${where}; refusing to fast-forward it from here.`,
      );
    }
    await git(["merge", "--ff-only", ref], repo);
  } else {
    await git(["branch", "-f", branch, ref], repo);
  }
  return "moved" as const;
}

export async function isAncestor(repo: string, a: string, b: string) {
  try {
    await git(["merge-base", "--is-ancestor", a, b], repo);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure `branch` exists locally: from the remote if it has one, else cut
 * from `base`. With a remote, fast-forward to it. The one place every job
 * starts from, so the integration branch is always the shared truth.
 */
export async function syncBranch(
  repo: string,
  branch: string,
  base: string,
  opts: { fetch: boolean; remote?: string } = { fetch: true },
) {
  const remote = opts.remote ?? "origin";
  const haveRemote = await hasRemote(repo, remote);
  if (haveRemote && opts.fetch) await fetch(repo, remote);
  const upstream = haveRemote
    ? await remoteSha(repo, branch, remote)
    : undefined;
  if (!(await branchExists(repo, branch))) {
    // Prefer the remote's copy of the base: the owner's pushes are the truth.
    const remoteBase =
      haveRemote && (await remoteSha(repo, base, remote))
        ? `${remote}/${base}`
        : base;
    await git(["branch", branch, upstream ?? remoteBase], repo);
    return;
  }
  if (upstream && opts.fetch) {
    await fastForward(repo, branch, `${remote}/${branch}`);
  }
}

export async function deleteRemoteBranch(
  repo: string,
  branch: string,
  remote = "origin",
) {
  await git(["push", remote, "--delete", branch], repo);
}

/** Ids recorded by `<key>: <id>` trailers on commits reachable from `ref`. */
export async function trailerValues(
  repo: string,
  ref: string,
  key: string,
): Promise<Set<string>> {
  const out = await git(
    ["log", ref, `--format=%(trailers:key=${key},valueonly)`],
    repo,
  );
  return new Set(
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * Squash-merge `branch` into the checked-out branch: the result is staged,
 * not committed, so the caller adds the message and trailer. Conflicts are
 * left in place for an agent, like merge().
 */
export async function squashMerge(
  cwd: string,
  branch: string,
): Promise<MergeOutcome> {
  try {
    const out = await git(["merge", "--squash", branch], cwd);
    if (/already up to date/i.test(out)) return { status: "up-to-date" };
    return { status: "merged" };
  } catch (err) {
    const files = await unmergedFiles(cwd);
    if (files.length) return { status: "conflict", files };
    throw err;
  }
}

export interface GhMergeOptions {
  subject: string;
  body: string;
  /** The PR head must still be this sha, or GitHub refuses. */
  matchHeadCommit: string;
  deleteBranch: boolean;
}

/** Squash-merge a PR on GitHub so it shows as merged there. */
export async function ghSquashMerge(
  repo: string,
  prNumber: number,
  opts: GhMergeOptions,
) {
  const args = [
    "pr",
    "merge",
    String(prNumber),
    "--squash",
    "--match-head-commit",
    opts.matchHeadCommit,
    "--subject",
    opts.subject,
    "--body",
    opts.body,
  ];
  if (opts.deleteBranch) args.push("--delete-branch");
  await execFileAsync("gh", args, { cwd: repo });
}

export async function ghClosePr(
  repo: string,
  prNumber: number,
  comment: string,
) {
  await execFileAsync(
    "gh",
    ["pr", "close", String(prNumber), "--comment", comment],
    { cwd: repo },
  );
}

export async function revParse(cwd: string, ref = "HEAD") {
  return git(["rev-parse", ref], cwd);
}

export async function resetHard(cwd: string, ref: string) {
  await git(["reset", "--hard", ref], cwd);
}

/** Abort an in-progress merge if there is one; a no-op otherwise. */
export async function mergeAbort(cwd: string) {
  try {
    await git(["merge", "--abort"], cwd);
  } catch {
    // no merge in progress
  }
}

/** Paths still carrying conflict markers in an in-progress merge. */
export async function unmergedFiles(cwd: string): Promise<string[]> {
  const out = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

export type MergeOutcome =
  | { status: "merged" }
  | { status: "up-to-date" }
  | { status: "conflict"; files: string[] };

/**
 * Merge `branch` into the checked-out branch with a merge commit. On
 * conflict the merge is left in progress so an agent can resolve it.
 */
export async function merge(
  cwd: string,
  branch: string,
  message: string,
): Promise<MergeOutcome> {
  try {
    const out = await git(
      ["merge", "--no-ff", "--no-edit", "-m", message, branch],
      cwd,
    );
    return /already up to date/i.test(out)
      ? { status: "up-to-date" }
      : { status: "merged" };
  } catch (err) {
    const files = await unmergedFiles(cwd);
    if (files.length) return { status: "conflict", files };
    throw err;
  }
}

/** Short names of local branches whose tip is already contained in `into`. */
export async function mergedBranches(repo: string, into: string) {
  const out = await git(
    ["branch", "--merged", into, "--format=%(refname:short)"],
    repo,
  );
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
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
  env: Record<string, string> = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
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

/** Append a section to a PR's body (used to carry review notes onto the PR). */
export async function ghAppendPrBody(
  repo: string,
  prNumber: number,
  section: string,
) {
  const { stdout } = await execFileAsync(
    "gh",
    ["pr", "view", String(prNumber), "--json", "body", "--jq", ".body"],
    { cwd: repo },
  );
  const bodyFile = path.join(repo, ".pr-body.tmp.md");
  fs.writeFileSync(bodyFile, `${stdout.trimEnd()}\n\n${section.trim()}\n`);
  try {
    await execFileAsync(
      "gh",
      ["pr", "edit", String(prNumber), "--body-file", bodyFile],
      { cwd: repo },
    );
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}
