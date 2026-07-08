// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "./log.js";

const traceLog = log.child("branch");

/**
 * Check if the first (most recent) branch entry is an ask_user_question tool answer.
 * Used to skip aUQ answers in the before_agent_start handler — they're already handled
 * by the tool_result handler. Returns true if the first entry is a toolResult
 * message with toolName "ask_user_question".
 */
export function isFirstEntryAskUserQuestion(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  if (!branch.length) return false;
  const first = branch[0] as SessionMessageEntryLike;
  return (
    first.type === "message" && first.message?.role === "toolResult" && first.message?.toolName === "ask_user_question"
  );
}

/**
 * Local type guard for an ask_user_question tool_result event. NO SDK helper exists for
 * tool_RESULT events (isToolCallEventType is tool_CALL only). ask_user_question
 * is registered by the avtc-pi-ask-user-question extension and fires as a CustomToolResultEvent
 * with toolName "ask_user_question" (portrait already treats its results as user messages).
 */
export function isAskUserQuestionResult(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const e = event as { type?: string; toolName?: string };
  return e.type === "tool_result" && e.toolName === "ask_user_question";
}

interface SessionMessageEntryLike {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
  };
}

/**
 * Walk the active branch (getBranch, which returns entries LEAF→ROOT — index 0 = most
 * recent) back to the most-recent assistant message's text. The "agentBefore" context for
 * a capture unit.
 *
 * SessionEntry shape: a message entry is { type: "message", message: { role, content } }
 * role/content are nested under `entry.message`, NOT on the entry directly. Skips
 * non-message entries (compaction, model changes, custom tool-call markers) and
 * non-text content (thinking, tool calls). Stops at user messages — a user message
 * marks a turn boundary; everything after it (backward) belongs to the agent's turn.
 * Returns null if no assistant message (with text) exists before the user boundary.
 */
export function lastAssistantText(ctx: ExtensionContext): string | null {
  const branch = ctx.sessionManager.getBranch(); // leaf→root (most recent first)

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    const e = entry as SessionMessageEntryLike;
    if (e.type !== "message") continue;
    if (e.message?.role !== "assistant") continue;
    const content = e.message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (c): c is { type: "text"; text: string } =>
          typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
      )
      .map((c) => c.text)
      .join("\n");
    if (text.length > 0) {
      traceLog.info(`assistant text (${text.length} chars): ${JSON.stringify(text.slice(0, 150))}`);
      return text;
    }
  }
  traceLog.info("no assistant text found on branch");
  return null;
}
