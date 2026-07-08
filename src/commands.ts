// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Slash-command handlers (`/user-decisions:list`, `/user-decisions:details`) — expose the decision
 * store to the USER via `ui.notify`, using the same read+filter+render path as the agent tools
 * (`render.ts`), so list/detail look identical whether shown to the agent (tool result) or the user
 * (notify). Read-only, lock-free (same as `user_decision_list`/`user_decision_detail`).
 */
import { queryDetail, queryList } from "./render.js";
import type { DecisionsConfig, TierPaths } from "./types.js";

/** Command result: `text` to display via ui.notify; `error` selects the notify severity. */
export interface CommandResult {
  text: string;
  error: boolean;
}

/** Narrow runtime for the browse commands — only the fields they read (tiers + ranking setting).
 * Not the full ToolRuntime: commands are read-only and lock-free, so they must NOT depend on
 * lockState/lockFilePath. Keeping this minimal decouples commands.ts from the lock machinery. */
export interface CommandRuntime {
  config: Pick<DecisionsConfig, "rankingEnabled">;
  tiers: TierPaths;
}

/**
 * `/user-decisions:list {substring?}` — list live (non-dropped) decisions, ordered per the ranking
 * setting (ranked = value order; not-ranked = most-recent first), optionally narrowed by substring.
 */
export function runListCommand(rt: CommandRuntime, args: string): CommandResult {
  const filter = args.trim();
  const { content } = queryList(rt.tiers, rt.config.rankingEnabled, {
    status: "live",
    filter: filter.length > 0 ? filter : null,
    limit: null,
  });
  return { text: content, error: false };
}

/**
 * `/user-decisions:details {id}` — show the full record (id/summary/timestamp/supersede chain/detail)
 * for the given id. Error result when the id is missing, non-numeric, or not found.
 */
export function runDetailsCommand(rt: CommandRuntime, args: string): CommandResult {
  const trimmed = args.trim();
  const id = Number.parseInt(trimmed, 10);
  if (trimmed.length === 0 || !Number.isFinite(id)) {
    return { text: "Usage: /user-decisions:details {id}", error: true };
  }
  const res = queryDetail(rt.tiers, id);
  if (!res.found) return { text: `No decision ${id}.`, error: true };
  return { text: res.content, error: false };
}
