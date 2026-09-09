/**
 * Orchestrator configuration.
 *
 * Everything project-specific lives in one JSON file (orchestrator.config.json)
 * so the orchestrator code itself stays reusable across repositories.
 * Paths in the file are relative to the file's own directory and are resolved
 * to absolute paths when loaded.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

/**
 * Tools a coder may use without asking. Everything else is denied, which the
 * agent sees and works around. Bash is limited to the package manager, git and
 * node so an agent cannot wander outside its worktree.
 */
export const DEFAULT_CODER_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "Glob",
  "Grep",
  "Bash(npm *)",
  "Bash(npx *)",
  "Bash(node *)",
  "Bash(git *)",
];

/** Settings shared by every LLM-backed agent (coders and integrator). */
const AgentSettingsSchema = z.object({
  /** Claude model ID handed to the Agent SDK. */
  model: z.string().default("claude-opus-5"),
  /** Reasoning depth. Higher costs more tokens but fewer wasted turns on hard PRs. */
  effort: EffortSchema.default("high"),
  /** Hard stop on agentic turns per attempt, so a stuck agent cannot loop forever. */
  maxTurns: z.number().int().positive().default(80),
  /** Hard stop on estimated spend per attempt (USD). */
  maxBudgetUsd: z.number().positive().default(5),
  /** Tool allowlist passed to the Agent SDK. */
  allowedTools: z.array(z.string()).default(DEFAULT_CODER_TOOLS),
});

/** How agent sessions are started. Lets a repo's own Claude Code settings and hooks see the orchestrator. */
const SessionSchema = z.object({
  /** Claude Code setting sources loaded into every session. "project" = the target repo's CLAUDE.md and .claude/. */
  settingSources: z
    .array(z.enum(["user", "project", "local"]))
    .default(["project"]),
  /** Extra environment variables for every session, e.g. a marker a repo's hooks can detect. */
  env: z.record(z.string(), z.string()).default({}),
  /** Keep transcripts in ~/.claude/projects so `claude --resume` and usage tools can read them. */
  persist: z.boolean().default(false),
});

/** Wave-packing rules beyond `depends_on` and `touches`. */
const SchedulingSchema = z.object({
  /**
   * Path prefixes whose specs run alone in their wave, before anything else,
   * because they move the base for everyone (e.g. database migrations).
   */
  serialPaths: z.array(z.string()).default([]),
});

const ReviewerSchema = z.object({
  name: z.string().min(1),
  /** Markdown prompt; YAML frontmatter (Claude Code agent files) is tolerated. */
  promptFile: z.string().min(1),
  allowedTools: z.array(z.string()).default(["Read", "Grep", "Glob"]),
});

/** Optional review stage between coding and integration. Off unless enabled. */
const ReviewSchema = z.object({
  enabled: z.boolean().default(false),
  reviewers: z.array(ReviewerSchema).default([]),
  /** Prints JSON `{ "reviewers": [names] }` for the diff; empty list skips review. */
  classifyCommand: z.string().optional(),
  model: z.string().default("claude-sonnet-5"),
  effort: EffortSchema.default("medium"),
  maxTurns: z.number().int().positive().default(25),
  maxBudgetUsd: z.number().positive().default(1.5),
  /** How many times a BLOCK verdict may send the PR back to a coder. */
  maxRounds: z.number().int().min(0).max(1).default(1),
  /** After the last round: merge with the findings noted on the PR, or fail it. */
  onExhausted: z
    .enum(["integrate-with-note", "fail"])
    .default("integrate-with-note"),
});

/** A repo-owned command the integrator fires after merges (e.g. trigger heavy CI). */
const PostMergeSchema = z.object({
  command: z.string().optional(),
  /** Run `command` after every N successful merges in a run. */
  everyNMerges: z.number().int().positive().optional(),
  /** Run `command` once when the run finishes with at least one merge. */
  atRunEnd: z.boolean().default(false),
});

export const OrchestratorConfigSchema = z.object({
  /** Root of the git repository the agents work on. */
  repoPath: z.string().default("."),
  /** Branch that only the owner deploys from. The orchestrator never touches it. */
  baseBranch: z.string().default("main"),
  /** Branch every PR is merged into by the integrator. Created from baseBranch if missing. */
  integrationBranch: z.string().default("integration"),
  /** PR branches are named `<branchPrefix>/<spec id>`. */
  branchPrefix: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("pr"),
  /** Coder worktree directory names are `<worktreeNamePrefix><spec id>`. */
  worktreeNamePrefix: z.string().default(""),
  /** Directory name of the integrator's worktree under worktreesDir. */
  integrationWorktreeName: z.string().min(1).default("_integration"),
  /** How a finished PR lands on integration: a merge commit, or one squashed commit. */
  mergeStrategy: z.enum(["merge", "squash"]).default("merge"),
  /** Fetch and fast-forward the integration branch from the remote before each job. */
  fetchBeforeWork: z.boolean().default(true),
  /** Delete the remote PR branch once it has landed (only if it still points at the merged commit). */
  deleteMergedBranches: z.boolean().default(false),
  /** Directory of PR spec markdown files (the static storage for PRs). */
  specsDir: z.string().default(".orchestrator/prs"),
  /** Directory where each run writes its ledger, summary and logs. */
  runsDir: z.string().default(".orchestrator/runs"),
  /** Where coder git worktrees are created. Kept outside the repo so tooling ignores them. */
  worktreesDir: z.string().default("../.orchestrator-worktrees"),
  /** Command that must pass before a PR is opened and after each merge. */
  checkCommand: z.string().default("npm run check"),
  /** Give up on checkCommand after this long. */
  checkTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  /** Junction the repo's node_modules into each worktree instead of reinstalling. */
  linkNodeModules: z.boolean().default(true),
  /** Optional shell command run inside a fresh worktree before the coder starts. */
  worktreeSetupCommand: z.string().optional(),
  /** Push branches and open GitHub PRs with `gh` when the repo has a remote. */
  openPullRequests: z.boolean().default(true),
  /** Push the integration branch after every merge when the repo has a remote. */
  pushIntegration: z.boolean().default(true),
  coders: AgentSettingsSchema.extend({
    /** How many coding agents run at once. */
    count: z.number().int().min(1).max(8).default(3),
  }).prefault({}),
  integrator: AgentSettingsSchema.extend({
    /** Check to run on the composed tree after each merge. Falls back to checkCommand. */
    checkCommand: z.string().optional(),
  }).prefault({}),
  session: SessionSchema.prefault({}),
  scheduling: SchedulingSchema.prefault({}),
  review: ReviewSchema.prefault({}),
  postMerge: PostMergeSchema.prefault({}),
  /** How many times a PR may be attempted before it is marked failed. */
  maxAttemptsPerPr: z.number().int().min(1).default(2),
  /**
   * Stop scheduling new waves once the run's estimated spend reaches this
   * (USD). PRs already in flight finish. Unset means no run-level cap; the
   * per-attempt caps still apply.
   */
  maxRunBudgetUsd: z.number().positive().optional(),
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
export type ReviewConfig = z.infer<typeof ReviewSchema>;
export type SessionConfig = z.infer<typeof SessionSchema>;
export type ReviewerConfig = z.infer<typeof ReviewerSchema>;

export const DEFAULT_CONFIG_FILE = "orchestrator.config.json";

/**
 * Read, validate and resolve the config file. Missing fields take defaults,
 * unknown fields are an error so typos surface immediately.
 */
export function loadConfig(
  configPath = DEFAULT_CONFIG_FILE,
): OrchestratorConfig {
  const absConfigPath = path.resolve(configPath);
  const raw = fs.existsSync(absConfigPath)
    ? (JSON.parse(fs.readFileSync(absConfigPath, "utf8")) as unknown)
    : {};
  const parsed = OrchestratorConfigSchema.strict().parse(raw);
  return resolvePaths(parsed, path.dirname(absConfigPath));
}

/** Make every path in the config absolute, relative to `baseDir`. */
export function resolvePaths(
  config: OrchestratorConfig,
  baseDir: string,
): OrchestratorConfig {
  const resolve = (p: string) => path.resolve(baseDir, p);
  return {
    ...config,
    repoPath: resolve(config.repoPath),
    specsDir: resolve(config.specsDir),
    runsDir: resolve(config.runsDir),
    worktreesDir: resolve(config.worktreesDir),
  };
}
