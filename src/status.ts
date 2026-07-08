// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import { readPauseState } from "./pause-state.js";
import { countRecords } from "./storage.js";
import type { DecisionsConfig, TierPaths } from "./types.js";

export interface StatusSnapshot {
  totalActive: number;
  queued: number;
  tokens: number;
  words: number; //  word-count fallback when provider doesn't stream usage
  paused: boolean;
}

/** mtime cache for the recurring poll: a write always bumps mtime (writeTier's tmp+rename),
 * so a stat whose mtimeMs matches the cached value lets us reuse the cached line count instead of
 * re-reading the file. Turns the steady-state 2s poll into two cheap `stat` calls rather than two
 * full reads of the (unbounded) tiers. Module-scoped: one cache per process, keyed by file path. */
const _countCache = new Map<string, { mtimeMs: number; count: number }>();

/** Count a tier's records, reusing the cached count when the file's mtime is unchanged.
 * ENOENT => 0 (and cached so we don't re-stat every tick for a still-absent file). */
function countRecordsCached(filePath: string): number {
  let stat: { mtimeMs: number };
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT" || code === "UNKNOWN") {
      // ENOENT = file gone; UNKNOWN (Windows errno -4094) = file being deleted/locked by another
      // process (e.g. sync tool). Both mean "treat as absent" to avoid crashing the poll timer.
      // Cache the absence (mtimeMs = -1 sentinel) so a still-absent file isn't re-statted each tick.
      const cached = _countCache.get(filePath);
      if (!cached || cached.mtimeMs !== -1) _countCache.set(filePath, { mtimeMs: -1, count: 0 });
      return 0;
    }
    throw err;
  }
  // Floor to whole milliseconds: mtimeMs fractional precision varies by FS / utimes round-trip, so
  // comparing on the ms granularity is both robust (a real write changes the ms) and stable
  // (an external rewrite that lands on the same ms — vanishingly rare — is an acceptable miss).
  const mtime = Math.floor(stat.mtimeMs);
  const cached = _countCache.get(filePath);
  if (cached && cached.mtimeMs === mtime) return cached.count; // unchanged → reuse
  const count = countRecords(filePath); // mtime bumped (or cold) → re-read
  _countCache.set(filePath, { mtimeMs: mtime, count });
  return count;
}

/** Invalidate the mtime cache (e.g. on session change — a new store at the same path
 * would otherwise look unchanged by mtime after a /new). */
export function invalidateCountCache(): void {
  _countCache.clear();
}

/** Count active + evicted (TotalActive). Lock-free line-count (NO JSON parse) — counting needs no
 * lock and no parse. Runs on recurring timers so the cheap count avoids parsing
 * the unbounded evicted tier on every tick; the mtime cache skips the read when unchanged. */
export function countTotalActive(tiers: TierPaths): number {
  let n = countRecordsCached(tiers.active);
  if (tiers.evicted) n += countRecordsCached(tiers.evicted);
  return n;
}

/**
 * Render the short status string for the shared footer slot (keep it very short).
 *  - both modes: `Q&A:{TotalActive}`
 *  - auto mode only: `·{N}🔜` (N = queued + in-processing, when N>0); `·{tokens} tok` (while streaming);
 *  `·{words} w` (while streaming when provider doesn't report usage — word-count fallback);
 *  `·⏸️` (when paused; background-only — agent/none ignore a stale persisted paused flag).
 */
export function renderStatus(cfg: DecisionsConfig, snap: StatusSnapshot, streaming: boolean): string {
  let s = `Q&A:${snap.totalActive}`;
  if (cfg.captureMode === "background") {
    const n = snap.queued + (streaming ? 1 : 0); // N = queued + in-processing (1 while streaming)
    if (n > 0) s += `·${n}🔜`;
    if (streaming && snap.tokens > 0) s += `·${snap.tokens} tok`;
    else if (streaming && snap.words > 0) s += `·${snap.words} words`;
    if (snap.paused) s += "·⏸️";
  }
  return s;
}

/**
 * Build a StatusSnapshot from the live store + queue depth + pause state (lock-free).
 * `activePath` is the session's active jsonl (for reading the persisted pause state).
 * `totalActiveOverride`: when provided, skips the file read and uses the cached count
 * (used while streaming — the count can't change mid-capture, so callers reuse the cache).
 * `pausedOverride`: when provided, skips the pause-state file read. Pause is written only
 * by /pause and /resume in THIS process, so the caller caches it (invalidated on those commands)
 * and the ~2/s streaming refreshStatus never re-reads the file.
 */
export function snapshot(
  cfg: DecisionsConfig,
  tiers: TierPaths,
  activePath: string,
  queued: number,
  tokens: number,
  words: number,
  totalActiveOverride: number | null,
  pausedOverride: boolean | null,
): StatusSnapshot {
  const paused = cfg.captureMode === "background" ? (pausedOverride ?? readPauseState(activePath).paused) : false;
  return {
    totalActive: totalActiveOverride ?? countTotalActive(tiers),
    queued,
    tokens,
    words,
    paused,
  };
}
