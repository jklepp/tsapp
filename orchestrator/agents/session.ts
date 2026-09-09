/**
 * One Agent SDK session, wrapped so the coder and the integrator share the
 * same plumbing: sandboxed tool allowlist, hard turn and budget caps, a
 * transcript on disk, and exact metrics from the final result message.
 *
 * `SessionRunner` is a function type so tests can inject a fake that edits a
 * worktree without calling a model.
 */
import fs from "node:fs";
import path from "node:path";
import {
  query,
  type SDKResultMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentSettings } from "../config.js";
import { phaseMetricsFromResult } from "../metrics.js";
import type { PhaseMetrics } from "../state.js";

export interface SessionRequest {
  /** Working directory the agent is confined to (a worktree or the repo). */
  cwd: string;
  prompt: string;
  /** Appended to Claude Code's standard coding system prompt. */
  systemAppend: string;
  settings: AgentSettings;
  /** Transcript file; created if missing. */
  logFile: string;
}

export interface SessionOutcome {
  result: SDKResultMessage;
  metrics: PhaseMetrics;
  /** The agent's final message (its summary), or "" if the session errored. */
  finalText: string;
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

export const runAgentSession: SessionRunner = async (req) => {
  const startedAt = new Date();
  fs.mkdirSync(path.dirname(req.logFile), { recursive: true });
  const log = fs.createWriteStream(req.logFile, { flags: "a" });
  log.write(`# session started ${startedAt.toISOString()} in ${req.cwd}\n\n`);
  const abortController = new AbortController();
  activeSessions.add(abortController);

  let result: SDKResultMessage | undefined;
  let lastText = "";
  try {
    for await (const msg of query({
      prompt: req.prompt,
      options: {
        abortController,
        cwd: req.cwd,
        model: req.settings.model,
        effort: req.settings.effort,
        maxTurns: req.settings.maxTurns,
        maxBudgetUsd: req.settings.maxBudgetUsd,
        allowedTools: req.settings.allowedTools,
        // Deny anything not on the allowlist instead of prompting; nobody is watching.
        permissionMode: "dontAsk",
        // Load the target repo's CLAUDE.md and .claude settings, not the user's.
        settingSources: ["project"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: req.systemAppend,
        },
        persistSession: false,
      },
    })) {
      const text = transcriptLine(msg);
      if (text) log.write(text + "\n");
      if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) lastText = block.text;
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
  const finalText = result.subtype === "success" ? result.result : lastText;
  return { result, metrics, finalText };
};

/** Compact one-line-per-event transcript: the agent's text and its tool calls. */
function transcriptLine(msg: SDKMessage): string | undefined {
  if (msg.type !== "assistant" || msg.parent_tool_use_id) return undefined;
  const lines: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text" && block.text.trim()) {
      lines.push(block.text.trim());
    } else if (block.type === "tool_use") {
      const input = JSON.stringify(block.input);
      lines.push(
        `[tool] ${block.name} ${input.length > 200 ? input.slice(0, 200) + "…" : input}`,
      );
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}
