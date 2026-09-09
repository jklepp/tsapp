// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "./metrics";
import { foldEvents, parseLedger, renderWatch } from "./watch";

const t0 = Date.parse("2026-09-09T18:00:00.000Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const ev = (type: string, s: number, data: Record<string, unknown> = {}) =>
  ({ ts: at(s), type, ...data }) as LedgerEvent;

describe("foldEvents + renderWatch", () => {
  const events: LedgerEvent[] = [
    ev("run:start", 0, { specs: ["a", "b", "c"], skipped: ["c"], coders: 3 }),
    ev("pr:dispatch", 1, { prId: "a", attempt: 1 }),
    ev("pr:dispatch", 1, { prId: "b", attempt: 1 }),
    ev("pr:session", 2, { prId: "a", phase: "coding", sessionId: "sess-a" }),
    ev("pr:usage", 3, {
      prId: "a",
      phase: "coding",
      turns: 1,
      inputTokens: 100,
      cacheReadTokens: 20000,
      cacheCreationTokens: 500,
    }),
    ev("pr:turn", 3, {
      prId: "a",
      phase: "coding",
      turn: 1,
      tool: "Read",
      summary: "Footer.tsx",
    }),
    ev("pr:turn", 4, {
      prId: "b",
      phase: "coding",
      turn: 2,
      tool: "Bash",
      summary: "npm test",
    }),
    ev("pr:session-end", 30, {
      prId: "a",
      phase: "coding",
      subtype: "success",
      turns: 8,
      costUsd: 0.31,
    }),
    ev("pr:coded", 31, { prId: "a", attempt: 1 }),
    ev("pr:coder-failed", 40, {
      prId: "b",
      attempt: 1,
      error: "check command failed\nmore",
      willRetry: true,
    }),
    ev("pr:integrating", 41, { prId: "a" }),
    ev("pr:merged", 50, { prId: "a" }),
  ];

  it("folds events into per-PR rows and a feed", () => {
    const s = foldEvents(events);
    expect(s.rows.get("c")?.state).toBe("merged (before run)");
    const a = s.rows.get("a")!;
    expect(a).toMatchObject({
      state: "merged",
      attempt: 1,
      turns: 8,
      tokens: 20600,
      costUsd: 0.31,
      sessionId: "sess-a",
    });
    expect(a.finishedAt).toBe(t0 + 50000);
    const b = s.rows.get("b")!;
    expect(b.state).toBe("retry queued");
    expect(b.lastAction).toBe("check command failed");
    expect(s.feed.map((f) => f.text)).toEqual([
      "[coding] Read Footer.tsx",
      "[coding] Bash npm test",
    ]);
  });

  it("renders an aligned table with elapsed times for active rows", () => {
    const live = foldEvents(events.slice(0, 7)); // a and b still coding
    const text = renderWatch(live, t0 + 10000);
    const lines = text.split("\n");
    expect(lines[0]).toContain("active 2");
    expect(text).toMatch(/a\s+coding\s+1\s+1\s+9s\s+20,600\s+Read Footer\.tsx/);
    expect(text).toMatch(/b\s+coding\s+1\s+2\s+9s\s+Bash npm test/);
    expect(text).toContain("Recent activity");
    expect(text).toContain("18:00:03  a: [coding] Read Footer.tsx");
  });

  it("marks the run finished and stops the clock", () => {
    const done = foldEvents([
      ...events,
      ev("run:end", 60, { merged: 2, failed: 0, costUsd: 0.5 }),
    ]);
    const text = renderWatch(done, t0 + 999000);
    expect(text).toContain("elapsed 1m00s");
    expect(text).toContain("run finished: 2 merged, 0 failed, $0.5000");
    expect(done.finished).toBe(t0 + 60000);
  });
});

describe("parseLedger", () => {
  it("skips a partially written last line", () => {
    const text =
      JSON.stringify({ ts: at(0), type: "run:start", specs: [] }) +
      "\n" +
      '{"ts":"2026-09-09T18:00:01.000Z","type":"pr:dis';
    expect(parseLedger(text)).toHaveLength(1);
  });
});
