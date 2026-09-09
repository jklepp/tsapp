/**
 * Command line entry point.
 *
 *   npm run orch -- validate            parse every spec and report problems
 *   npm run orch -- plan                show dependency order and a wave preview
 *   npm run orch -- smoke               one tiny Agent SDK session; prints a metrics row
 *   npm run orch -- run --stub          run the whole graph with stub agents (free)
 *                    [--fail-once id]   make that PR's first coding attempt fail
 *                    [--fail id]        make every attempt for that PR fail
 *   npm run orch -- code <id>           run the real coder on one spec (spends tokens)
 *                    [--attempt N]      continue on the existing branch as attempt N
 *
 * Later steps add: run (real agents), resume, status.
 */
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createCoder } from "./agents/coder.js";
import { stubCoder, stubIntegrator } from "./agents/stub.js";
import { loadConfig } from "./config.js";
import {
  phaseMetricsFromResult,
  renderSummaryTable,
  summarize,
} from "./metrics.js";
import { newRunId, runOrchestrator } from "./run.js";
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

function plan(): void {
  if (!validate()) process.exitCode = 1;
  const specs = loadSpecs(config.specsDir);
  console.log("\nExecution order (dependencies first, then priority):");
  topologicalOrder(specs).forEach((s, i) => console.log(`  ${i + 1}. ${s.id}`));
  console.log(`\nWave preview with ${config.coders.count} coder(s):`);
  previewWaves(specs, config.coders.count).forEach((wave, i) =>
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
  console.log("\n" + renderSummaryTable(summarize("smoke", prs)));
}

async function run(): Promise<void> {
  if (!flags.stub) {
    throw new Error(
      "Real integration arrives in Step 4. For now use: npm run orch -- run --stub",
    );
  }
  const stubOpts = {
    delayMs: 300,
    failOnce: listFlag("fail-once"),
    failAlways: listFlag("fail"),
  };
  const t0 = Date.now();
  const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
  const summary = await runOrchestrator(config, {
    coder: stubCoder(stubOpts),
    integrator: stubIntegrator(stubOpts),
    onLog: (line) => console.log(`${stamp()} ${line}`),
  });
  console.log(`\nRun ${summary.runId} written to ${config.runsDir}`);
  console.log("\n" + renderSummaryTable(summary));
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
    console.log("\n" + renderSummaryTable(summarize(runId, prs)));
  }
}

const commands: Record<string, () => void | Promise<void>> = {
  validate: () => {
    if (!validate()) process.exitCode = 1;
  },
  plan,
  smoke,
  run,
  code,
  help: () =>
    console.log("Commands: validate | plan | smoke | run --stub | code <id>"),
};

const handler = commands[command];
if (!handler) {
  console.error(
    `Unknown command "${command}". Commands: validate | plan | smoke | run --stub | code <id>`,
  );
  process.exit(1);
}
await handler();
