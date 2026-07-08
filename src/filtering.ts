// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Filtering for the background capture pipeline.
 * Detects continuation messages, extension-generated follow-ups, and skill injection blocks.
 */

/**
 * Bare continuation phrases injected by the framework (not meaningful user input).
 * These trigger phase transitions or compaction follow-ups.
 */
export const CONTINUATION_PATTERNS: RegExp[] = [
  /^continue$/i, // bare continue (agent-lifecycle, compaction)
  /^commit$/i, // bare commit (phase transition)
  /^please continue$/i, // empty response auto-retry (agent-lifecycle.ts)
  /^commit then proceed$/i, // commit + continue (phase transition)
  /^commit your changes$/i, // commit request (phase transition)
  /^commit files you have changed$/i, // commit request (phase transition)
];

export function isContinuation(text: string): boolean {
  const t = text.trim();
  return CONTINUATION_PATTERNS.some((p) => p.test(t));
}

/**
 * Patterns for extension-generated messages that should not be captured.
 * Filters auto-generated follow-ups (compaction restoration, phase transitions, review
 * loop handoffs) while preserving user confirmations ("yes", "ok", "approved", "proceed")
 * that represent genuine decisions.
 */
export const EXTENSION_MESSAGE_PATTERNS: RegExp[] = [
  /^Plan review complete/i, // buildExecutionHandoffMessage (review-context.ts)
  /^Design review complete/i, // design-review handoff
  /^Feature review complete/i, // feature-review handoff
  /^Code review complete/i, // code-review handoff
  /^TODO #\d/i, // compaction TODO re-injection (compaction.ts)
  /^Continuing work on feature:/i, // kanban auto-agent (auto-agent-lifecycle.ts)
  /^▶ \d+:/, // pi-todo context reset follow-up (handlers.ts)
  /^\[Pending dialog/i, // compaction dialog restoration (compaction.ts)
  /^Run design review iteration/i, // design review loop follow-up (phase-ready.ts)
  /^Run plan review iteration/i, // plan review loop follow-up (phase-ready.ts)
  /^Context was compacted/i, // compaction restoration message (compact-message.ts)
  /^Context was reset between tasks/i, // plan-tracker task continuation (plan-tracker.ts)
  /^Work on feature:/i, // kanban auto-agent lifecycle (auto-agent-lifecycle.ts)
];

export function isExtensionMessage(text: string): boolean {
  const t = text.trim();
  return EXTENSION_MESSAGE_PATTERNS.some((p) => p.test(t));
}

/**
 * Strip skill injection blocks and /skill: prefixes from content.
 * Handles both complete blocks (<skill>...</skill>) and unclosed blocks (<skill>...to end).
 */
export function stripSkillBlocks(content: string): string {
  let stripped = content.replace(/<skill\s+name="[^"]*"[^>]*>[\s\S]*?<\/skill>/g, "");
  stripped = stripped.replace(/<skill\s+name="[^"]*"[^>]*>[\s\S]*/g, "");
  stripped = stripped.trim();
  stripped = stripped.replace(/^\s*\/skill:[^\s]*\s*/i, "").trim();
  return stripped;
}
