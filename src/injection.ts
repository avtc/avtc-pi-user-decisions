// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { formatRecordLine } from "./decisions.js";
import { readTier } from "./storage.js";
import type { TierPaths } from "./types.js";

// Approved header. The ordering phrase is config-aware.
const HEADER_RANKED = `## User Decisions (this session)
Captured user decisions and Q&A, ordered by value (most valuable first). This is a
partial snapshot — more decisions exist and new ones will arise during the conversation.
Add new decisions with user_decision_add; recall any not shown here (including superseded)
with user_decision_list / user_decision_detail. Decisions added mid-conversation are saved
immediately but will NOT appear in this section until the next reload/compaction.`;

const HEADER_NOT_RANKED = HEADER_RANKED.replace("ordered by value (most valuable first)", "most-recent first");

/**
 * Render the injected system-prompt section. Returns null when the store is empty
 * (the whole section is omitted). NO LLM: just reads the head.
 *  - ranked: top `limit` lines of active (already most-valuable-first)
 *  - not ranked: last `limit` lines, reversed (file is oldest→newest → render most-recent-first)
 */
export function renderInjection(tiers: TierPaths, rankingEnabled: boolean, limit: number): string | null {
  const active = readTier(tiers.active); // missing file => []
  if (active.length === 0) return null;
  const head = rankingEnabled ? active.slice(0, limit) : active.slice(-limit).reverse();
  const body = head.map((r) => `- ${formatRecordLine(r)}`).join("\n"); // plain id + sanitized summary (decisions.ts formatRecordLine)
  return `${rankingEnabled ? HEADER_RANKED : HEADER_NOT_RANKED}\n${body}\n`;
}
