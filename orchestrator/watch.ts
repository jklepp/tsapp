/**
 * Live view of a run, built purely from ledger events so it can be rendered
 * from another terminal, replayed from a finished ledger, and unit-tested.
 *
 * The ledger already records dispatch, integration, per-turn activity and
 * running token counts; this folds them into one row per PR plus a feed of
 * the agents' latest actions.
 */
import type { LedgerEvent } from "./metrics.js";

export interface LiveRow {
  prId: string;
  /** What the PR is doing now, or how it ended. */
  state: string;
  phase?: string;
  attempt: number;
  turns: number;
  /** Input + cache tokens so far; output tokens are only known at session end. */
  tokens: number;
  costUsd?: number;
  lastAction?: string;
  startedAt?: number;
  finishedAt?: number;
  sessionId?: string;
}

export interface LiveState {
  runId?: string;
  started?: number;
  finished?: number;
  rows: Map<string, LiveRow>;
  feed: { ts: number; prId: string; text: string }[];
  lastLine?: string;
}

export function foldEvents(events: LedgerEvent[], feedSize = 12): LiveState {
  const s: LiveState = { rows: new Map(), feed: [] };
  const row = (id: string): LiveRow => {
    let r = s.rows.get(id);
    if (!r) {
      r = { prId: id, state: "queued", attempt: 0, turns: 0, tokens: 0 };
      s.rows.set(id, r);
    }
    return r;
  };
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  for (const e of events) {
    const ts = Date.parse(e.ts);
    const id = typeof e.prId === "string" ? e.prId : undefined;
    switch (e.type) {
      case "run:start":
        s.started = ts;
        for (const spec of (e.specs as string[]) ?? []) row(spec);
        for (const done of (e.skipped as string[]) ?? []) {
          row(done).state = "merged (before run)";
        }
        break;
      case "run:resume":
        s.started ??= ts;
        break;
      case "pr:dispatch":
        if (id) {
          const r = row(id);
          r.state = "coding";
          r.phase = "coding";
          r.attempt = num(e.attempt);
          r.startedAt = ts;
          r.finishedAt = undefined;
          r.turns = 0;
          r.tokens = 0;
          r.lastAction = undefined;
        }
        break;
      case "pr:session":
        if (id) row(id).sessionId = e.sessionId as string;
        break;
      case "pr:turn":
        if (id) {
          const r = row(id);
          r.turns = Math.max(r.turns, num(e.turn));
          const text = e.tool
            ? `${e.tool} ${e.summary ?? ""}`.trim()
            : String(e.summary ?? "");
          r.lastAction = text;
          s.feed.push({ ts, prId: id, text: `[${e.phase}] ${text}` });
          if (s.feed.length > feedSize) s.feed.shift();
        }
        break;
      case "pr:usage":
        if (id) {
          const r = row(id);
          r.turns = Math.max(r.turns, num(e.turns));
          r.tokens =
            num(e.inputTokens) +
            num(e.cacheReadTokens) +
            num(e.cacheCreationTokens);
        }
        break;
      case "pr:session-end":
        if (id) {
          const r = row(id);
          r.costUsd = (r.costUsd ?? 0) + num(e.costUsd);
          r.turns = Math.max(r.turns, num(e.turns));
        }
        break;
      case "pr:coded":
        if (id) {
          const r = row(id);
          r.state = "PR open";
          r.phase = undefined;
        }
        break;
      case "pr:coder-failed":
        if (id) {
          const r = row(id);
          r.state = e.willRetry ? "retry queued" : "failed";
          r.finishedAt = ts;
          r.lastAction = String(e.error ?? "").split("\n")[0];
        }
        break;
      case "pr:integrating":
        if (id) {
          const r = row(id);
          r.state = "integrating";
          r.phase = "integration";
        }
        break;
      case "pr:merged":
        if (id) {
          const r = row(id);
          r.state = "merged";
          r.phase = undefined;
          r.finishedAt = ts;
        }
        break;
      case "pr:rejected":
        if (id) {
          const r = row(id);
          r.state = e.willRetry ? "rejected, retry queued" : "failed";
          r.phase = undefined;
          r.lastAction = String(e.error ?? "").split("\n")[0];
        }
        break;
      case "pr:blocked":
        if (id) {
          const r = row(id);
          r.state = "failed (dependency)";
          r.finishedAt = ts;
        }
        break;
      case "run:end":
        s.finished = ts;
        s.lastLine = `run finished: ${e.merged} merged, ${e.failed} failed, $${num(e.costUsd).toFixed(4)}`;
        break;
      case "run:budget-exceeded":
        s.lastLine = "run budget reached; no new waves";
        break;
      default:
        break;
    }
  }
  return s;
}

const fmtMs = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60
    ? `${sec}s`
    : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
};
const fmtInt = (n: number) => n.toLocaleString("en-US");

export function renderWatch(state: LiveState, now = Date.now()): string {
  const active = [...state.rows.values()].filter(
    (r) => r.state === "coding" || r.state === "integrating",
  );
  const cols = [
    { h: "PR", right: false },
    { h: "State", right: false },
    { h: "Try", right: true },
    { h: "Turns", right: true },
    { h: "Elapsed", right: true },
    { h: "Tokens", right: true },
    { h: "Last action", right: false },
  ];
  const cells = [...state.rows.values()].map((r) => {
    const end = r.finishedAt ?? (active.includes(r) ? now : undefined);
    const elapsed = r.startedAt && end ? fmtMs(end - r.startedAt) : "";
    return [
      r.prId,
      r.state,
      r.attempt ? String(r.attempt) : "",
      r.turns ? String(r.turns) : "",
      elapsed,
      r.tokens ? fmtInt(r.tokens) : "",
      (r.lastAction ?? "").slice(0, 60),
    ];
  });
  const widths = cols.map((c, i) =>
    Math.max(c.h.length, ...cells.map((row) => row[i].length)),
  );
  const line = (row: string[]) =>
    row
      .map((v, i) =>
        cols[i].right ? v.padStart(widths[i]) : v.padEnd(widths[i]),
      )
      .join("  ")
      .trimEnd();
  const header =
    (state.runId ? `Run ${state.runId}` : "Run") +
    (state.started
      ? `  elapsed ${fmtMs((state.finished ?? now) - state.started)}`
      : "") +
    `  active ${active.length}`;
  const out = [
    header,
    "",
    line(cols.map((c) => c.h)),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...cells.map(line),
  ];
  if (state.feed.length) {
    out.push("", "Recent activity");
    for (const f of state.feed) {
      out.push(
        `  ${new Date(f.ts).toISOString().slice(11, 19)}  ${f.prId}: ${f.text}`,
      );
    }
  }
  if (state.lastLine) out.push("", state.lastLine);
  return out.join("\n");
}

/** Parse a ledger file's lines; tolerates a partially written last line. */
export function parseLedger(text: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      // partial trailing write; the next poll will see it whole
    }
  }
  return events;
}
