/**
 * Command line entry point.
 *
 *   npm run orch -- validate            parse every spec and report problems
 *   npm run orch -- plan                show dependency order and a wave preview
 *   npm run orch -- smoke               one tiny Agent SDK session; prints a metrics row
 *   npm run orch -- run                 run every spec with the real agents (spends tokens)
 *   npm run orch -- run --stub          run the whole graph with stub agents (free)
 *                    [--fail-once id]   make that PR's first coding attempt fail
 *                    [--fail id]        make every attempt for that PR fail
 *   npm run orch -- code <id>           run the real coder on one spec (spends tokens)
 *                    [--attempt N]      continue on the existing branch as attempt N
 *   npm run orch -- integrate <id>      merge pr/<id> into integration (free unless
 *                                       there is a conflict or the checks break)
 *   npm run orch -- resume [runId]      continue an interrupted run (latest by default)
 *   npm run orch -- status [runId]      show a run's state from its checkpoint
 */
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createCoder } from "./agents/coder.js";
import { branchFor } from "./naming.js";
import { createIntegrator } from "./agents/integrator.js";
import { stubCoder, stubIntegrator } from "./agents/stub.js";
import { loadConfig } from "./config.js";
import {
  phaseMetricsFromResult,
  renderConsoleTable,
  summarize,
} from "./metrics.js";
import {
  alreadyMerged,
  getRunState,
  latestRunId,
  newRunId,
  resumeOrchestrator,
  runOrchestrator,
} from "./run.js";
import { abortAllSessions } from "./agents/session.js";
import type { RunSummary } from "./metrics.js";
import {
  loadSpecs,
  previewWaves,
  topologicalOrder,
  validateSpecs,
} from "./spec.js";
import { initialPrRecords, type PrRecord } from "./state.js";

const [command = "help", ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => !a.startsWith("--"));
const flags = parseFlags(rest);
const config = loadConfig(process.env.ORCH_CONFIG);

function parseFlags(args: string[]): Record<string, string[] | true> {
  const out: Record<string, string[] | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      const list = Array.isArray(out[key]) ? (out[key] as string[]) : [];
      out[key] = [...list, next];
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const listFlag = (key: string): string[] =>
  Array.isArray(flags[key]) ? (flags[key] as string[]) : [];

function validate(): boolean {
  const specs = loadSpecs(config.specsDir);
  const problems = validateSpecs(specs);
  console.log(`Loaded ${specs.length} spec(s) from ${config.specsDir}`);
  for (const s of specs) {
    const deps = s.dependsOn.length ? ` (after ${s.dependsOn.join(", ")})` : "";
    console.log(
      `  ${s.id}  p${s.priority}  ${s.title}${deps}  [${s.bodyChars} chars]`,
    );
  }
  if (problems.length) {
    console.error("\nProblems:");
    problems.forEach((p) => console.error(`  - ${p}`));
    return false;
  }
  console.log("\nAll specs valid.");
  return true;
}

async function plan(): Promise<void> {
  if (!validate()) process.exitCode = 1;
  const specs = loadSpecs(config.specsDir);
  const done = await alreadyMerged(config);
  const merged = specs
    .filter((s) => done.has(branchFor(config, s.id)))
    .map((s) => s.id);
  if (merged.length) {
    console.log(
      `\nAlready merged into ${config.integrationBranch}, will be skipped: ${merged.join(", ")}`,
    );
  }
  console.log("\nExecution order (dependencies first, then priority):");
  topologicalOrder(specs)
    .filter((s) => !merged.includes(s.id))
    .forEach((s, i) => console.log(`  ${i + 1}. ${s.id}`));
  console.log(`\nWave preview with ${config.coders.count} coder(s):`);
  const waves = previewWaves(specs, config.coders.count, merged);
  if (waves.length === 0) console.log("  nothing to do");
  waves.forEach((wave, i) =>
    console.log(`  wave ${i + 1}: ${wave.map((s) => s.id).join(", ")}`),
  );
  console.log(
    `\nIntegration branch: ${config.integrationBranch} (base: ${config.baseBranch})`,
  );
}

async function smoke(): Promise<void> {
  console.log(
    `Smoke test: one ${config.coders.model} session, no tools, one turn.`,
  );
  const startedAt = new Date();
  let result: SDKResultMessage | undefined;
  for await (const msg of query({
    prompt: "Reply with exactly the word OK and nothing else.",
    options: {
      cwd: config.repoPath,
      model: config.coders.model,
      effort: "low",
      maxTurns: 1,
      tools: [],
      persistSession: false,
      systemPrompt:
        "You are a connectivity check. Follow the instruction literally.",
    },
  })) {
    if (msg.type === "result") result = msg;
  }
  if (!result) throw new Error("No result message received from the Agent SDK");
  if (result.subtype !== "success") {
    throw new Error(`Session ended with ${result.subtype}`);
  }
  console.log(`Model replied: ${JSON.stringify(result.result.trim())}`);
  const metrics = phaseMetricsFromResult(
    result,
    startedAt,
    config.coders.model,
  );
  const prs = initialPrRecords([]);
  prs["smoke"] = {
    id: "smoke",
    title: "smoke",
    specPath: "",
    priority: 3,
    dependsOn: [],
    touches: [],
    status: "merged",
    attempts: 1,
    coding: metrics,
  };
  console.log("\n" + renderConsoleTable(summarize("smoke", prs)));
}

/** Real agents by default; `--stub` swaps in the free stand-ins. */
function selectAgents() {
  const stubOpts = {
    delayMs: 300,
    failOnce: listFlag("fail-once"),
    failAlways: listFlag("fail"),
  };
  console.log(
    flags.stub
      ? "Stub run: no tokens will be spent."
      : `Live run: coders on ${config.coders.model} (max $${config.coders.maxBudgetUsd}/attempt), integrator on ${config.integrator.model}` +
          (config.maxRunBudgetUsd
            ? `, run budget $${config.maxRunBudgetUsd}.`
            : ", no run budget."),
  );
  return flags.stub
    ? { coder: stubCoder(stubOpts), integrator: stubIntegrator(stubOpts) }
    : { coder: createCoder(), integrator: createIntegrator() };
}

function consoleLogger() {
  const t0 = Date.now();
  return (line: string) =>
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
}

function printSummary(summary: RunSummary): void {
  console.log(`\nRun ${summary.runId} written to ${config.runsDir}`);
  console.log("\n" + renderConsoleTable(summary));
}

async function run(): Promise<void> {
  const summary = await runOrchestrator(config, {
    ...selectAgents(),
    onLog: consoleLogger(),
  });
  printSummary(summary);
}

/** Continue an interrupted run from its last checkpoint. */
async function resume(): Promise<void> {
  const runId = positional[0] ?? latestRunId(config);
  if (!runId) throw new Error(`No run with a checkpoint in ${config.runsDir}`);
  const summary = await resumeOrchestrator(config, runId, {
    ...selectAgents(),
    onLog: consoleLogger(),
  });
  printSummary(summary);
}

/** Show a run's state from its last checkpoint. Read-only; safe during a run. */
async function status(): Promise<void> {
  const runId = positional[0] ?? latestRunId(config);
  if (!runId) throw new Error(`No run with a checkpoint in ${config.runsDir}`);
  const state = await getRunState(config, runId);
  const counts: Record<string, number> = {};
  for (const pr of Object.values(state.prs)) {
    counts[pr.status] = (counts[pr.status] ?? 0) + 1;
  }
  console.log(`Run ${runId}`);
  console.log(
    `  ${Object.entries(counts)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ")}`,
  );
  console.log(
    state.next.length
      ? `  in progress; next graph step: ${state.next.join(", ")} (resume with: npm run orch -- resume ${runId})`
      : "  complete",
  );
  for (const pr of Object.values(state.prs)) {
    if (pr.error) console.log(`  ${pr.id}: ${pr.error.split("\n")[0]}`);
  }
  console.log("\n" + renderConsoleTable(summarize(runId, state.prs)));
}

/** Merge one existing pr/<id> branch into integration, outside the graph. */
async function integrate(): Promise<void> {
  const id = positional[0];
  if (!id) throw new Error("Usage: npm run orch -- integrate <spec-id>");
  const spec = loadSpecs(config.specsDir).find((s) => s.id === id);
  if (!spec) throw new Error(`No spec with id "${id}" in ${config.specsDir}`);
  const runId = `integrate-${newRunId()}`;
  const pr: PrRecord = {
    ...initialPrRecords([spec])[id],
    status: "integrating",
    attempts: 1,
    branch: branchFor(config, id),
  };
  console.log(
    `Merging ${pr.branch} into ${config.integrationBranch} (run ${runId})`,
  );
  const result = await createIntegrator()(pr, { config, runId, attempt: 1 });
  if (result.outcome === "merged") {
    console.log(
      result.metrics.numTurns === 0
        ? "\nMerged cleanly; no model session was needed."
        : "\nMerged after a model session.",
    );
  } else {
    console.log(`\nRejected: ${result.error}`);
    process.exitCode = 1;
  }
  if (result.metrics) {
    const prs = {
      [id]: {
        ...pr,
        status:
          result.outcome === "merged"
            ? ("merged" as const)
            : ("pr-open" as const),
        integration: result.metrics,
      },
    };
    console.log("\n" + renderConsoleTable(summarize(runId, prs)));
  }
}

/** Run the real coder on a single spec, outside the graph. Spends tokens. */
async function code(): Promise<void> {
  const id = positional[0];
  if (!id)
    throw new Error("Usage: npm run orch -- code <spec-id> [--attempt N]");
  const spec = loadSpecs(config.specsDir).find((s) => s.id === id);
  if (!spec) throw new Error(`No spec with id "${id}" in ${config.specsDir}`);
  const attempt = Number(listFlag("attempt")[0] ?? 1);
  const runId = `code-${newRunId()}`;
  const pr: PrRecord = { ...initialPrRecords([spec])[id], attempts: attempt };
  console.log(
    `Coding ${id} with ${config.coders.model} (attempt ${attempt}, run ${runId})`,
  );
  console.log(`Transcript: ${config.runsDir}\\${runId}\\logs\\`);
  const result = await createCoder()(pr, { config, runId, attempt });
  if (result.outcome === "pr-open") {
    console.log(
      `\nPR open on branch ${result.branch}${result.prUrl ? ` ${result.prUrl}` : " (no remote; local branch only)"}`,
    );
  } else {
    console.log(
      `\nFailed${result.retryable === false ? " (not retryable)" : ""}: ${result.error}`,
    );
    process.exitCode = 1;
  }
  if (result.metrics) {
    const prs = {
      [id]: {
        ...pr,
        status:
          result.outcome === "pr-open"
            ? ("pr-open" as const)
            : ("failed" as const),
        coding: result.metrics,
      },
    };
    console.log("\n" + renderConsoleTable(summarize(runId, prs)));
  }
}

const commands: Record<string, () => void | Promise<void>> = {
  validate: () => {
    if (!validate()) process.exitCode = 1;
  },
  plan,
  smoke,
  run,
  resume,
  status,
  code,
  integrate,
  help: () => console.log(`Commands: ${COMMAND_LIST}`),
};
const COMMAND_LIST =
  "validate | plan | smoke | run [--stub] | resume [runId] | status [runId] | code <id> | integrate <id>";

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command "${command}". Commands: ${COMMAND_LIST}`);
  process.exit(1);
}

// Ctrl+C: stop the agent subprocesses too, then leave the checkpoint for resume.
process.on("SIGINT", () => {
  const n = abortAllSessions();
  console.error(
    `\nInterrupted. Aborted ${n} agent session(s). Continue later with: npm run orch -- resume`,
  );
  process.exit(130);
});

await handler();
