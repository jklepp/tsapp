// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  Ledger,
  phaseMetricsFromResult,
  renderConsoleTable,
  renderSummaryTable,
  summarize,
} from "./metrics";
import type { PrRecord } from "./state";

const fakeResult = (): SDKResultMessage =>
  ({
    type: "result",
    subtype: "success",
    duration_ms: 5000,
    duration_api_ms: 4000,
    is_error: false,
    num_turns: 7,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0.42,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {
      "claude-opus-5": {
        inputTokens: 1000,
        outputTokens: 300,
        cacheReadInputTokens: 20000,
        cacheCreationInputTokens: 5000,
        webSearchRequests: 0,
        costUSD: 0.4,
        contextWindow: 1000000,
        maxOutputTokens: 128000,
      },
    },
    permission_denials: [],
    uuid: "u",
    session_id: "s",
  }) as unknown as SDKResultMessage;

describe("phaseMetricsFromResult", () => {
  it("sums modelUsage and keeps the larger cost estimate", () => {
    const started = new Date(Date.now() - 1234);
    const m = phaseMetricsFromResult(fakeResult(), started, "claude-opus-5");
    expect(m.inputTokens).toBe(1000);
    expect(m.outputTokens).toBe(300);
    expect(m.cacheReadTokens).toBe(20000);
    expect(m.cacheCreationTokens).toBe(5000);
    expect(m.costUsd).toBe(0.42);
    expect(m.numTurns).toBe(7);
    expect(m.apiDurationMs).toBe(4000);
    expect(m.durationMs).toBeGreaterThanOrEqual(1234);
    expect(m.model).toBe("claude-opus-5");
  });
});

describe("summarize + renderSummaryTable", () => {
  it("adds coding and integration phases per PR and totals across PRs", () => {
    const phase = (n: number) => ({
      startedAt: "",
      finishedAt: "",
      durationMs: n * 1000,
      apiDurationMs: n * 900,
      numTurns: n,
      inputTokens: n,
      outputTokens: n,
      cacheReadTokens: n,
      cacheCreationTokens: n,
      costUsd: n / 100,
      model: "m",
    });
    const base = {
      specPath: "",
      priority: 3,
      dependsOn: [],
      touches: [],
      attempts: 1,
    };
    const prs: Record<string, PrRecord> = {
      b: {
        ...base,
        id: "b",
        title: "b",
        status: "merged",
        coding: phase(2),
        integration: phase(1),
      },
      a: { ...base, id: "a", title: "a", status: "failed", coding: phase(4) },
    };
    const s = summarize("run-1", prs);
    expect(s.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(s.rows[1]).toMatchObject({
      totalMs: 3000,
      numTurns: 3,
      totalTokens: 12,
      billedTokens: 9, // excludes the 3 cache-read tokens
      costUsd: 0.03,
    });
    expect(s.totals).toMatchObject({
      totalMs: 7000,
      numTurns: 7,
      totalTokens: 28,
      billedTokens: 21,
    });
    const table = renderSummaryTable(s);
    expect(table).toContain("| a | failed | 1 | 4 |");
    expect(table).toContain("| Cache rd |");
    expect(table).toContain("**total**");

    const lines = renderConsoleTable(s).split("\n");
    expect(lines).toHaveLength(6); // header, rule, a, b, rule, total
    expect(lines[0].startsWith("PR")).toBe(true);
    expect(lines[0]).not.toContain("Cache rd");
    // Every line is padded to the same width, so columns line up.
    const widths = new Set(lines.map((l) => l.trimEnd().length));
    expect(widths.size).toBeLessThanOrEqual(2);
    // PR  Status  Tries  Turns  Coding  Integr.  Total tok  Billed tok  Cost
    expect(lines[2]).toMatch(
      /^a\s+failed\s+1\s+4\s+4s\s+0s\s+0s\s+16\s+12\s+\$0\.0400$/,
    );
    expect(lines[5]).toMatch(
      /^total\s+7\s+6s\s+0s\s+1s\s+28\s+21\s+\$0\.0700$/,
    );
  });
});

describe("Ledger", () => {
  it("appends one JSON line per event", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-"));
    const ledger = new Ledger(dir, "run-x");
    ledger.event("run:start");
    ledger.event("pr:coding", { prId: "a" });
    const lines = fs
      .readFileSync(path.join(ledger.runDir, "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ type: "pr:coding", prId: "a" });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
