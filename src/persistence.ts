// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "./log.js";

const persistLog = log.child("persistence");

export const DECISIONS_CACHE_TYPE = "user-decisions-cache";

/** Snapshot of the rendered injection cache, to propagate to forked subagent children. */
export interface DecisionsCacheSnapshot {
  content: string;
}

/**
 * Persist the current rendered cache as a CustomEntry.
 *
 * Failure model:
 *  - Programming error (`pi`/`pi.appendEntry` missing) → **throw** (fail loud; a live
 *  ExtensionAPI always exposes appendEntry). No `?.` guarding.
 *  - Environmental error (`appendEntry` call fails: disk full, permission, I/O) → caught,
 *  logged via `persistLog.warn`, and degraded (cache stays valid in memory).
 *
 * No-op when `cache` is null/empty (empty store / injection disabled).
 */
export function persistCacheSnapshot(pi: ExtensionAPI, cache: string | null): void {
  if (!cache) return;
  // Programming error — fail loud. Explicit check (no `?.`): the contract is that
  // a live ExtensionAPI exposes appendEntry; a violation here is a design flaw, not a runtime edge.
  if (pi === undefined || pi === null || typeof pi.appendEntry !== "function") {
    throw new Error("persistCacheSnapshot: pi.appendEntry unavailable (broken ExtensionAPI contract)");
  }
  try {
    pi.appendEntry(DECISIONS_CACHE_TYPE, { content: cache } satisfies DecisionsCacheSnapshot);
  } catch (err) {
    // Environmental (disk full, permission, I/O) — log and degrade; cache is still valid in memory.
    persistLog.warn(`Failed to persist user-decisions-cache snapshot: ${err}`);
  }
}

/**
 * Walk the session branch in reverse; return the latest `user-decisions-cache` snapshot, or
 * undefined if none/malformed.
 *
 * Failure model:
 *  - Programming error (`ctx.sessionManager`/`getBranch` missing) → **throw** (fail loud; no `?.`).
 *  - Environmental error (`getBranch` throws on corrupt session / I/O, or malformed entry) →
 *  caught, logged, returns undefined → caller falls back to the file read.
 *
 * NOTE: do NOT add the avtc-pi-todo `PI_SUBAGENT_PARENT_PID` guard here — a forked subagent child
 * MUST restore the parent's snapshot (that is the entire point of this feature).
 */
export function restoreCacheSnapshot(ctx: ExtensionContext): DecisionsCacheSnapshot | undefined {
  // Programming error — fail loud. Explicit check (no `?.`).
  if (
    ctx === undefined ||
    ctx === null ||
    ctx.sessionManager === undefined ||
    ctx.sessionManager === null ||
    typeof ctx.sessionManager.getBranch !== "function"
  ) {
    throw new Error("restoreCacheSnapshot: ctx.sessionManager.getBranch unavailable (broken contract)");
  }
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as { type: string; customType?: string; data?: unknown };
      if (entry.type === "custom" && entry.customType === DECISIONS_CACHE_TYPE) {
        const content = (entry.data as DecisionsCacheSnapshot | undefined)?.content;
        if (typeof content === "string" && content.length > 0) return { content };
        persistLog.warn("Found user-decisions-cache CustomEntry with missing/invalid content; falling back to file");
        return undefined;
      }
    }
    return undefined;
  } catch (err) {
    persistLog.warn(`Failed to restore user-decisions-cache snapshot: ${err}`);
    return undefined;
  }
}
