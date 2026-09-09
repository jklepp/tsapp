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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
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
      inputTokens: add("inputTokens"),
      outputTokens: add("outputTokens"),
      cacheReadTokens: add("cacheReadTokens"),
      cacheCreationTokens: add("cacheCreationTokens"),
      totalTokens: add("totalTokens"),
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

/** Column definitions shared by the markdown and console renderers. */
const COLUMNS: {
  header: string;
  right: boolean;
  cell: (id: string, status: string, tries: string, m: Metrics) => string;
}[] = [
  { header: "PR", right: false, cell: (id) => id },
  { header: "Status", right: false, cell: (_, status) => status },
  { header: "Tries", right: true, cell: (_, __, tries) => tries },
  { header: "Coding", right: true, cell: (_, __, ___, m) => fmtMs(m.codingMs) },
  {
    header: "Integr.",
    right: true,
    cell: (_, __, ___, m) => fmtMs(m.integrationMs),
  },
  { header: "In", right: true, cell: (_, __, ___, m) => fmtInt(m.inputTokens) },
  {
    header: "Out",
    right: true,
    cell: (_, __, ___, m) => fmtInt(m.outputTokens),
  },
  {
    header: "Cache rd",
    right: true,
    cell: (_, __, ___, m) => fmtInt(m.cacheReadTokens),
  },
  {
    header: "Cache wr",
    right: true,
    cell: (_, __, ___, m) => fmtInt(m.cacheCreationTokens),
  },
  {
    header: "Total tok",
    right: true,
    cell: (_, __, ___, m) => fmtInt(m.totalTokens),
  },
  {
    header: "Cost",
    right: true,
    cell: (_, __, ___, m) => `$${m.costUsd.toFixed(4)}`,
  },
];

function tableCells(summary: RunSummary, totalLabel: string): string[][] {
  const rows = summary.rows.map((r) =>
    COLUMNS.map((c) => c.cell(r.id, r.status, String(r.attempts), r)),
  );
  rows.push(COLUMNS.map((c) => c.cell(totalLabel, "", "", summary.totals)));
  return rows;
}

/** Markdown table, for summary.md and PR comments. */
export function renderSummaryTable(summary: RunSummary): string {
  const header = `| ${COLUMNS.map((c) => c.header).join(" | ")} |`;
  const align = `|${COLUMNS.map((c) => (c.right ? "---:" : "---")).join("|")}|`;
  const body = tableCells(summary, "**total**").map(
    (cells) => `| ${cells.join(" | ")} |`,
  );
  return [header, align, ...body].join("\n");
}

/** Aligned plain-text table, for the terminal. */
export function renderConsoleTable(summary: RunSummary): string {
  const rows = tableCells(summary, "total");
  const widths = COLUMNS.map((c, i) =>
    Math.max(c.header.length, ...rows.map((r) => r[i].length)),
  );
  const pad = (text: string, i: number) =>
    COLUMNS[i].right ? text.padStart(widths[i]) : text.padEnd(widths[i]);
  const line = (cells: string[]) => cells.map(pad).join("  ").trimEnd();
  const header = line(COLUMNS.map((c) => c.header));
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
