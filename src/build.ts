// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { applyInsert, buildDecisionRecord, readTierSnapshot, type TierSnapshot } from "./decisions.js";
import { nextId, readAllTiered } from "./storage.js";
import type { TierPaths } from "./types.js";

/** A distilled decision/Q&A extracted from the conversation (Phase 1 output → Phase 2 input). */
export interface Candidate {
  summary: string;
  detail: string;
}

/** The build LLM's decision for a candidate vs the existing ranked store. */
export interface BuildResult {
  action: "insert" | "skip" | "supersede";
  beforePosition: number | null;
  supersedes: number[] | null;
}

/**
 * Apply a build decision to the store (caller holds the lock). Constructs the record via the
 * SHARED `buildDecisionRecord` helper (src/decisions.ts — one record-construction path for
 * manual + auto-catch: no schema drift), then delegates to `applyInsert` (one write path:
 * positioning + supersede-across-all-tiers + mechanical eviction).
 * `snap` (optional): when the caller has ALREADY read the tiers under the lock (e.g.
 * runCapture reads once for the build-LLM context), thread that snapshot in to avoid a redundant
 * re-read while the cross-process mutex is held. When omitted, applyBuild reads the snapshot
 * itself (read-modify-write still atomic since the caller holds the lock).
 * `action: "skip"` is a no-op (returns the would-be id without writing) — the caller
 * (autocatch.runCapture) checks action before calling, but we handle it defensively.
 */
export function applyBuild(
  tiers: TierPaths,
  candidate: Candidate,
  decision: BuildResult,
  rankingEnabled: boolean,
  limit: number,
  now: Date,
  snap: TierSnapshot | null,
): number {
  // skip = nothing to write (duplicate of existing). The caller (runCapture) checks this
  // before calling, but we short-circuit defensively so applyBuild can't be misused to
  // persist a skip. Returns the would-be next id without writing.
  if (decision.action === "skip")
    return nextId(snap ? [...snap.active, ...snap.evicted, ...snap.dropped] : readAllTiered(tiers));
  // Read all tiers ONCE — or reuse the caller-provided snapshot (no re-read under lock).
  const snapshot = snap ?? readTierSnapshot(tiers);
  const all = [...snapshot.active, ...snapshot.evicted, ...snapshot.dropped];
  // insert / supersede → build the record via the shared helper, then position + write.
  const { rec, supersedes } = buildDecisionRecord(
    all,
    candidate,
    decision.action === "supersede" ? decision.supersedes : null,
    now,
  );
  // Manual uses beforeId; builder uses beforePosition — same semantics (insert before the named id).
  // Both feed the shared helper. Only `insert` carries positioning; supersede inserts at top.
  const beforeId = decision.action === "insert" ? decision.beforePosition : null;
  return applyInsert(tiers, snapshot, rec, beforeId, supersedes, rankingEnabled, limit);
}
