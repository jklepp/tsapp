/**
 * One Agent SDK session, wrapped so the coder, the integrator and reviewers
 * share the same plumbing: sandboxed tool allowlist, hard turn and budget
 * caps, a transcript on disk, live progress events, and exact metrics from
 * the final result message.
 *
 * `SessionRunner` is a function type so tests can inject a fake that edits a
 * worktree without calling a model.
 */
import fs from "node:fs";
import path from "node:path";
import {
  query,
  type Options,
  type SDKResultMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentSettings, SessionConfig } from "../config.js";
import { phaseMetricsFromResult } from "../metrics.js";
import type { PhaseMetrics } from "../state.js";

/** Progress events a session emits while it runs; the harness forwards them to the ledger. */
export type SessionEvent =
  | { kind: "start"; sessionId: string }
  | { kind: "turn"; turn: number; tool?: string; summary: string }
  | {
      kind: "usage";
      turns: number;
      inputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  | { kind: "end"; subtype: string; turns: number; costUsd: number };

export interface SessionRequest {
  /** Working directory the agent is confined to (a worktree or the repo). */
  cwd: string;
  prompt: string;
  /** Appended to Claude Code's standard coding system prompt. */
  systemAppend: string;
  settings: AgentSettings;
  /** How the session is started (setting sources, env, persistence). */
  session?: SessionConfig;
  /** Transcript file; created if missing. */
  logFile: string;
  onEvent?: (event: SessionEvent) => void;
}

export interface SessionOutcome {
  result: SDKResultMessage;
  metrics: PhaseMetrics;
  /** The agent's final message (its summary), or "" if the session errored. */
  finalText: string;
  /** Claude Code session id; with `session.persist`, `claude --resume <id>` opens it. */
  sessionId?: string;
}

export type SessionRunner = (req: SessionRequest) => Promise<SessionOutcome>;

/** Every live session's controller, so Ctrl+C can stop the agent subprocesses. */
const activeSessions = new Set<AbortController>();

export function abortAllSessions(): number {
  const n = activeSessions.size;
  for (const c of activeSessions) c.abort();
  activeSessions.clear();
  return n;
}

/** The Agent SDK options for a request. Pure, so tests can check the mapping. */
export function queryOptionsFor(
  req: SessionRequest,
  abortController: AbortController,
): Options {
  const session = req.session;
  return {
    abortController,
    cwd: req.cwd,
    model: req.settings.model,
    effort: req.settings.effort,
    maxTurns: req.settings.maxTurns,
    maxBudgetUsd: req.settings.maxBudgetUsd,
    allowedTools: req.settings.allowedTools,
    // Deny anything not on the allowlist instead of prompting; nobody is watching.
    permissionMode: "dontAsk",
    // Which Claude Code settings the session sees. Default: the target repo's only.
    settingSources: session?.settingSources ?? ["project"],
    // The SDK replaces the subprocess env entirely, so always start from ours.
    ...(session && Object.keys(session.env).length
      ? { env: { ...process.env, ...session.env } }
      : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: req.systemAppend,
    },
    persistSession: session?.persist ?? false,
  };
}

export const runAgentSession: SessionRunner = async (req) => {
  const startedAt = new Date();
  fs.mkdirSync(path.dirname(req.logFile), { recursive: true });
  const log = fs.createWriteStream(req.logFile, { flags: "a" });
  log.write(`# session started ${startedAt.toISOString()} in ${req.cwd}\n\n`);
  const abortController = new AbortController();
  activeSessions.add(abortController);
  const emit = req.onEvent ?? (() => {});

  let result: SDKResultMessage | undefined;
  let sessionId: string | undefined;
  let lastText = "";
  let turns = 0;
  const seenSteps = new Set<string>();
  const running = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  try {
    for await (const msg of query({
      prompt: req.prompt,
      options: queryOptionsFor(req, abortController),
    })) {
      if (!sessionId && "session_id" in msg && msg.session_id) {
        sessionId = msg.session_id;
        log.write(`# session id ${sessionId}\n\n`);
        emit({ kind: "start", sessionId });
      }
      if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        // One API step can arrive as several assistant messages sharing an id.
        if (!seenSteps.has(msg.message.id)) {
          seenSteps.add(msg.message.id);
          turns += 1;
          const u = msg.message.usage;
          running.inputTokens += u.input_tokens ?? 0;
          running.cacheReadTokens += u.cache_read_input_tokens ?? 0;
          running.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
          emit({ kind: "usage", turns, ...running });
        }
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            lastText = block.text;
            log.write(block.text.trim() + "\n");
            emit({ kind: "turn", turn: turns, summary: clip(block.text, 160) });
          } else if (block.type === "tool_use") {
            const input = JSON.stringify(block.input);
            log.write(`[tool] ${block.name} ${clip(input, 200)}\n`);
            emit({
              kind: "turn",
              turn: turns,
              tool: block.name,
              summary: clip(toolSummary(block.name, block.input), 120),
            });
          }
        }
      }
      if (msg.type === "result") result = msg;
    }
  } catch (err) {
    // The SDK throws after yielding an error result; the result is still usable.
    log.write(`\n[session error] ${(err as Error).message}\n`);
    if (!result) {
      log.end();
      throw err;
    }
  } finally {
    activeSessions.delete(abortController);
  }
  if (!result) {
    log.end();
    throw new Error("Agent session produced no result message");
  }
  const metrics = phaseMetricsFromResult(result, startedAt, req.settings.model);
  log.write(
    `\n# session ended ${result.subtype}; turns=${result.num_turns} ` +
      `in=${metrics.inputTokens} out=${metrics.outputTokens} ` +
      `cacheRead=${metrics.cacheReadTokens} cacheWrite=${metrics.cacheCreationTokens} ` +
      `cost=$${metrics.costUsd.toFixed(4)}\n`,
  );
  log.end();
  emit({
    kind: "end",
    subtype: result.subtype,
    turns: result.num_turns,
    costUsd: metrics.costUsd,
  });
  const finalText = result.subtype === "success" ? result.result : lastText;
  return { result, metrics, finalText, sessionId };
};

const clip = (text: string, max: number) => {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
};

/** The one field of a tool call a human wants to see in a live feed. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof i[k] === "string") return i[k] as string;
    return undefined;
  };
  switch (name) {
    case "Bash":
      return pick("command") ?? "";
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
      return (pick("file_path") ?? "").replace(/^.*[\\/]/, "");
    case "Glob":
    case "Grep":
      return pick("pattern") ?? "";
    default:
      return (
        pick("description", "command", "file_path", "pattern", "query") ?? ""
      );
  }
}

/** Kept for callers that only want the compact transcript text of a message. */
export function transcriptLine(msg: SDKMessage): string | undefined {
  if (msg.type !== "assistant" || msg.parent_tool_use_id) return undefined;
  const lines: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text" && block.text.trim()) {
      lines.push(block.text.trim());
    } else if (block.type === "tool_use") {
      lines.push(
        `[tool] ${block.name} ${clip(JSON.stringify(block.input), 200)}`,
      );
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * Adapter from session events to ledger events, tagged with the phase so a
 * live view can tell a coder from the integrator working on the same PR.
 */
export function forwardSessionEvents(
  ctx: { onEvent?: (type: string, data?: Record<string, unknown>) => void },
  phase: "coding" | "integration" | "review",
): ((event: SessionEvent) => void) | undefined {
  if (!ctx.onEvent) return undefined;
  const emit = ctx.onEvent;
  return (event) => {
    switch (event.kind) {
      case "start":
        emit("pr:session", { phase, sessionId: event.sessionId });
        return;
      case "turn":
        emit("pr:turn", {
          phase,
          turn: event.turn,
          tool: event.tool,
          summary: event.summary,
        });
        return;
      case "usage":
        emit("pr:usage", {
          phase,
          turns: event.turns,
          inputTokens: event.inputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheCreationTokens: event.cacheCreationTokens,
        });
        return;
      case "end":
        emit("pr:session-end", {
          phase,
          subtype: event.subtype,
          turns: event.turns,
          costUsd: event.costUsd,
        });
        return;
    }
  };
}
