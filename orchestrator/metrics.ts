/**
 * Metrics: exact token counts, cost estimate and wall-clock duration per PR.
 *
 * Source of truth is the Agent SDK `result` message that ends every agent
 * session. Its `modelUsage` map counts every request in the session, including
 * any subagents, broken down by model, so we sum across models. The `usage`
 * field on the same message undercounts when subagents run, so we avoid it.
 *
 * Every run gets a directory under runsDir:
 *   ledger.jsonl   append-only event log (one JSON object per line)
 *   summary.json   per-PR rows plus totals, written at the end of the run
 *   summary.md     the same table, readable in a terminal or a PR comment
 */
import fs from "node:fs";
import path from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PhaseMetrics, PrRecord } from "./state.js";

export function phaseMetricsFromResult(
  result: SDKResultMessage,
  startedAt: Date,
  fallbackModel: string,
): PhaseMetrics {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
  const models = Object.entries(result.modelUsage ?? {});
  for (const [, u] of models) {
    totals.inputTokens += u.inputTokens;
    totals.outputTokens += u.outputTokens;
    totals.cacheReadTokens += u.cacheReadInputTokens;
    totals.cacheCreationTokens += u.cacheCreationInputTokens;
    totals.costUsd += u.costUSD;
  }
  // Prefer the SDK's own total; it includes work the per-model map may miss.
  if (result.total_cost_usd > totals.costUsd)
    totals.costUsd = result.total_cost_usd;

  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    apiDurationMs: result.duration_api_ms,
    numTurns: result.num_turns,
    ...totals,
    model:
      models.length === 1
        ? models[0][0]
        : models.length
          ? "mixed"
          : fallbackModel,
  };
}

/**
 * Sum two phase records, for a PR that needed more than one attempt. Tokens,
 * cost, turns and durations add up; the window spans first start to last end.
 */
export function addPhaseMetrics(
  previous: PhaseMetrics | undefined,
  next: PhaseMetrics | undefined,
): PhaseMetrics | undefined {
  if (!previous) return next;
  if (!next) return previous;
  return {
    startedAt: previous.startedAt,
    finishedAt: next.finishedAt,
    durationMs: previous.durationMs + next.durationMs,
    apiDurationMs: previous.apiDurationMs + next.apiDurationMs,
    numTurns: previous.numTurns + next.numTurns,
    inputTokens: previous.inputTokens + next.inputTokens,
    outputTokens: previous.outputTokens + next.outputTokens,
    cacheReadTokens: previous.cacheReadTokens + next.cacheReadTokens,
    cacheCreationTokens:
      previous.cacheCreationTokens + next.cacheCreationTokens,
    costUsd: previous.costUsd + next.costUsd,
    model: previous.model === next.model ? next.model : "mixed",
  };
}

export type LedgerEvent = {
  ts: string;
  type: string;
  prId?: string;
  [key: string]: unknown;
};

/** Append-only JSONL log for one run. Cheap to write, easy to grep later. */
export class Ledger {
  readonly runDir: string;
  private readonly file: string;

  constructor(runsDir: string, runId: string) {
    this.runDir = path.join(runsDir, runId);
    fs.mkdirSync(this.runDir, { recursive: true });
    this.file = path.join(this.runDir, "ledger.jsonl");
  }

  event(type: string, data: Omit<LedgerEvent, "ts" | "type"> = {}): void {
    const entry: LedgerEvent = { ts: new Date().toISOString(), type, ...data };
    fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
  }
}

export interface PrSummaryRow {
  id: string;
  status: string;
  attempts: number;
  codingMs: number;
  integrationMs: number;
  totalMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Everything the model processed: input + output + cache reads + cache writes. */
  totalTokens: number;
  /**
   * Tokens charged at full rate: input + output + cache writes. Cache reads
   * are excluded because they are billed at a 90% discount. This is the
   * number to watch when tuning prompts; totalTokens mostly tracks turns.
   */
  billedTokens: number;
  costUsd: number;
  prUrl?: string;
}

export interface RunSummary {
  runId: string;
  generatedAt: string;
  rows: PrSummaryRow[];
  totals: Omit<PrSummaryRow, "id" | "status" | "attempts" | "prUrl">;
}

const sumPhase = (a?: PhaseMetrics, b?: PhaseMetrics) => {
  const phases = [a, b].filter((p): p is PhaseMetrics => p !== undefined);
  const pick = (k: keyof PhaseMetrics) =>
    phases.reduce((n, p) => n + (p[k] as number), 0);
  return {
    numTurns: pick("numTurns"),
    inputTokens: pick("inputTokens"),
    outputTokens: pick("outputTokens"),
    cacheReadTokens: pick("cacheReadTokens"),
    cacheCreationTokens: pick("cacheCreationTokens"),
    costUsd: pick("costUsd"),
  };
};

export function summarize(
  runId: string,
  prs: Record<string, PrRecord>,
): RunSummary {
  const rows: PrSummaryRow[] = Object.values(prs)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((pr) => {
      const t = sumPhase(pr.coding, pr.integration);
      const codingMs = pr.coding?.durationMs ?? 0;
      const integrationMs = pr.integration?.durationMs ?? 0;
      return {
        id: pr.id,
        status: pr.status,
        attempts: pr.attempts,
        codingMs,
        integrationMs,
        totalMs: codingMs + integrationMs,
        ...t,
        totalTokens:
          t.inputTokens +
          t.outputTokens +
          t.cacheReadTokens +
          t.cacheCreationTokens,
        billedTokens: t.inputTokens + t.outputTokens + t.cacheCreationTokens,
        prUrl: pr.prUrl,
      };
    });
  const add = (k: keyof PrSummaryRow) =>
    rows.reduce((n, r) => n + ((r[k] as number) || 0), 0);
  return {
    runId,
    generatedAt: new Date().toISOString(),
    rows,
    totals: {
      codingMs: add("codingMs"),
      integrationMs: add("integrationMs"),
      totalMs: add("totalMs"),
      numTurns: add("numTurns"),
      inputTokens: add("inputTokens"),
      outputTokens: add("outputTokens"),
      cacheReadTokens: add("cacheReadTokens"),
      cacheCreationTokens: add("cacheCreationTokens"),
      totalTokens: add("totalTokens"),
      billedTokens: add("billedTokens"),
      costUsd: add("costUsd"),
    },
  };
}

const fmtMs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

const fmtInt = (n: number) => n.toLocaleString("en-US");

type Metrics = Omit<PrSummaryRow, "id" | "status" | "attempts" | "prUrl">;

interface Column {
  header: string;
  right: boolean;
  /** Shown in the compact console table. Markdown shows every column. */
  console: boolean;
  cell: (id: string, status: string, tries: string, m: Metrics) => string;
}

const metric = (
  header: string,
  get: (m: Metrics) => string,
  console = true,
): Column => ({
  header,
  right: true,
  console,
  cell: (_, __, ___, m) => get(m),
});

/** Column definitions shared by the markdown and console renderers. */
const COLUMNS: Column[] = [
  { header: "PR", right: false, console: true, cell: (id) => id },
  { header: "Status", right: false, console: true, cell: (_, s) => s },
  { header: "Tries", right: true, console: true, cell: (_, __, t) => t },
  metric("Turns", (m) => fmtInt(m.numTurns)),
  metric("Coding", (m) => fmtMs(m.codingMs)),
  metric("Integr.", (m) => fmtMs(m.integrationMs)),
  metric("In", (m) => fmtInt(m.inputTokens), false),
  metric("Out", (m) => fmtInt(m.outputTokens), false),
  metric("Cache rd", (m) => fmtInt(m.cacheReadTokens), false),
  metric("Cache wr", (m) => fmtInt(m.cacheCreationTokens), false),
  metric("Total tok", (m) => fmtInt(m.totalTokens)),
  metric("Billed tok", (m) => fmtInt(m.billedTokens)),
  metric("Cost", (m) => `$${m.costUsd.toFixed(4)}`),
];

function tableCells(
  columns: Column[],
  summary: RunSummary,
  totalLabel: string,
): string[][] {
  const rows = summary.rows.map((r) =>
    columns.map((c) => c.cell(r.id, r.status, String(r.attempts), r)),
  );
  rows.push(columns.map((c) => c.cell(totalLabel, "", "", summary.totals)));
  return rows;
}

/** Markdown table with every column, for summary.md and PR comments. */
export function renderSummaryTable(summary: RunSummary): string {
  const header = `| ${COLUMNS.map((c) => c.header).join(" | ")} |`;
  const align = `|${COLUMNS.map((c) => (c.right ? "---:" : "---")).join("|")}|`;
  const body = tableCells(COLUMNS, summary, "**total**").map(
    (cells) => `| ${cells.join(" | ")} |`,
  );
  const note =
    "Total tok = everything processed. Billed tok = total minus cache reads (the tokens charged at full rate).";
  return [header, align, ...body, "", note].join("\n");
}

/** Aligned plain-text table with the essential columns, for the terminal. */
export function renderConsoleTable(summary: RunSummary): string {
  const columns = COLUMNS.filter((c) => c.console);
  const rows = tableCells(columns, summary, "total");
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...rows.map((r) => r[i].length)),
  );
  const pad = (text: string, i: number) =>
    columns[i].right ? text.padStart(widths[i]) : text.padEnd(widths[i]);
  const line = (cells: string[]) => cells.map(pad).join("  ").trimEnd();
  const header = line(columns.map((c) => c.header));
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows.map(line);
  // Separate the total row from the PR rows.
  body.splice(body.length - 1, 0, rule);
  return [header, rule, ...body].join("\n");
}

export function writeSummary(runDir: string, summary: RunSummary): void {
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  fs.writeFileSync(
    path.join(runDir, "summary.md"),
    `# Run ${summary.runId}\n\nGenerated ${summary.generatedAt}\n\n${renderSummaryTable(summary)}\n`,
  );
}
