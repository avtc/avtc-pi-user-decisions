// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as path from "node:path";
import type { TierPaths } from "./types.js";

/** <cwd>/.pi/user-decisions/sessions — created at load via mkdirSync(recursive). */
export function sessionsDir(cwd: string): string {
  return path.join(cwd, ".pi", "user-decisions", "sessions");
}

/** <cwd>/.pi/user-decisions — the extension data root (sessions/, debug/, *.lock.sqlite). */
export function dataDir(cwd: string): string {
  return path.join(cwd, ".pi", "user-decisions");
}

/** Is this process the root session (not a subagent)? root-vs-subagent gate. */
export function isRootSession(): boolean {
  return !process.env.PI_SUBAGENT_PARENT_PID;
}

/**
 * Resolve the ACTIVE tier path for this process.
 * - Root: <cwd>/.pi/user-decisions/sessions/<sessionId>.jsonl (computed from sessionId).
 * - Subagent: process.env.PI_DECISIONS_SESSION_FILE verbatim (child's own sessionId differs).
 * Returns null when a subagent lacks the env var (degraded — edge cases).
 */
export function resolveActivePath(cwd: string, sessionId: string): string | null {
  if (isRootSession()) return path.join(sessionsDir(cwd), `${sessionId}.jsonl`);
  const env = process.env.PI_DECISIONS_SESSION_FILE;
  return env && env.length > 0 ? env : null;
}

/** Derive a sibling file path next to the active jsonl: `<id>.<suffix>` (centralizes the
 * `.jsonl`-suffix assumption — ). Used for evicted/dropped tiers, the lock DB, pause state.
 * Replaces the trailing `.jsonl`; if the active path somehow lacks the suffix the result keeps it
 * appended (degrades loudly rather than aliasing tiers and corrupting the store). */
export function siblingPath(activePath: string, suffix: string): string {
  return activePath.endsWith(".jsonl")
    ? `${activePath.slice(0, -".jsonl".length)}.${suffix}`
    : `${activePath}.${suffix}`;
}

/** Derive all tier file paths from the active path (file layout). */
export function tierPaths(activePath: string, rankingEnabled: boolean): TierPaths {
  // active: <id>.jsonl; evicted: <id>.evicted.jsonl; dropped: <id>.dropped.jsonl
  return {
    active: activePath,
    evicted: rankingEnabled ? siblingPath(activePath, "evicted.jsonl") : null,
    dropped: siblingPath(activePath, "dropped.jsonl"),
  };
}

/** Lock DB path sits next to the active jsonl (node:sqlite mutex sentinel). */
export function lockDbPath(activePath: string): string {
  return siblingPath(activePath, "lock.sqlite");
}
