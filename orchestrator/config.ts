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

export const OrchestratorConfigSchema = z.object({
  /** Root of the git repository the agents work on. */
  repoPath: z.string().default("."),
  /** Branch that only the owner deploys from. The orchestrator never touches it. */
  baseBranch: z.string().default("main"),
  /** Branch every PR is merged into by the integrator. Created from baseBranch if missing. */
  integrationBranch: z.string().default("integration"),
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
  integrator: AgentSettingsSchema.prefault({}),
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
