// @vitest-environment node
import { describe, expect, it } from "vitest";
import { OrchestratorConfigSchema } from "../config";
import {
  forwardSessionEvents,
  queryOptionsFor,
  toolSummary,
  type SessionRequest,
} from "./session";

const base = (): SessionRequest => ({
  cwd: "C:/wt/x",
  prompt: "do it",
  systemAppend: "rules",
  settings: OrchestratorConfigSchema.parse({}).coders,
  logFile: "C:/runs/x.log",
});

describe("queryOptionsFor", () => {
  it("defaults to project settings, no env override, no persistence", () => {
    const o = queryOptionsFor(base(), new AbortController());
    expect(o.settingSources).toEqual(["project"]);
    expect(o.env).toBeUndefined();
    expect(o.persistSession).toBe(false);
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.allowedTools).toContain("Bash(git *)");
  });

  it("applies the session config and merges env over the process env", () => {
    const session = OrchestratorConfigSchema.parse({
      session: {
        settingSources: ["user", "project"],
        env: { ORCH_SESSION: "1" },
        persist: true,
      },
    }).session;
    const o = queryOptionsFor({ ...base(), session }, new AbortController());
    expect(o.settingSources).toEqual(["user", "project"]);
    expect(o.env?.ORCH_SESSION).toBe("1");
    expect(Object.keys(o.env ?? {}).length).toBeGreaterThan(1);
    expect(o.persistSession).toBe(true);
  });
});

describe("toolSummary", () => {
  it("picks the human-relevant field per tool", () => {
    expect(toolSummary("Bash", { command: "npm test" })).toBe("npm test");
    expect(toolSummary("Edit", { file_path: "C:\\a\\b\\Footer.tsx" })).toBe(
      "Footer.tsx",
    );
    expect(toolSummary("Grep", { pattern: "foo" })).toBe("foo");
    expect(toolSummary("Other", {})).toBe("");
  });
});

describe("forwardSessionEvents", () => {
  it("maps session events to phase-tagged ledger events", () => {
    const seen: [string, Record<string, unknown> | undefined][] = [];
    const fwd = forwardSessionEvents(
      { onEvent: (t, d) => seen.push([t, d]) },
      "coding",
    )!;
    fwd({ kind: "start", sessionId: "abc" });
    fwd({ kind: "turn", turn: 2, tool: "Bash", summary: "npm test" });
    fwd({
      kind: "usage",
      turns: 2,
      inputTokens: 10,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
    });
    fwd({ kind: "end", subtype: "success", turns: 9, costUsd: 0.4 });
    expect(seen.map(([t]) => t)).toEqual([
      "pr:session",
      "pr:turn",
      "pr:usage",
      "pr:session-end",
    ]);
    expect(seen[1][1]).toMatchObject({ phase: "coding", tool: "Bash" });
    expect(forwardSessionEvents({}, "coding")).toBeUndefined();
  });
});
