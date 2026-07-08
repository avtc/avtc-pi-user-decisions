// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { nextId, readTier, writeTier } from "./storage.js";
import type { DecisionRecord, TierPaths } from "./types.js";

/** A pre-read snapshot of all tiers (avoids redundant disk reads within one mutation). */
export interface TierSnapshot {
  active: DecisionRecord[];
  evicted: DecisionRecord[];
  dropped: DecisionRecord[];
}

/** Read all three tiers ONCE into a snapshot (used by applyAdd/applyBuild to avoid re-reading). */
export function readTierSnapshot(tiers: TierPaths): TierSnapshot {
  return {
    active: readTier(tiers.active),
    evicted: tiers.evicted ? readTier(tiers.evicted) : [],
    dropped: readTier(tiers.dropped),
  };
}

export interface AddInput {
  summary: string;
  detail: string;
  beforeId: number | null; // ranked only; null = top (ranked) / ignored (not ranked)
  supersedes: number[] | null;
  rankingEnabled: boolean;
  limit: number;
}

export interface AddResult {
  id: number;
  summary: string;
  superseded: number[]; // ids actually moved to dropped
}

/**
 * SHARED write path (caller holds the lock). Used by BOTH `applyAdd` (manual, below) and
 * `applyBuild` (auto-catch) — one correct, tested implementation so the two capture
 * modes can never drift. Returns the new record's id.
 *  - beforeId: insert before this id (ranked only); null → top (ranked) / ignored (not ranked).
 *  If beforeId is filtered out by supersedes (contradictory input), falls back to top.
 *  - supersedes: ids this record replaces — found WHEREVER they live (active/evicted/dropped
 *  per ), moved to `dropped`; the new record already carries `rec.supersedes`.
 */
export function applyInsert(
  tiers: TierPaths,
  snap: TierSnapshot,
  rec: DecisionRecord,
  beforeId: number | null,
  supersedes: number[],
  rankingEnabled: boolean,
  limit: number,
): number {
  const supSet = new Set(supersedes);
  const active = snap.active;
  let newActive = active.filter((r) => !supSet.has(r.id));
  // `currentEvicted` is tracked IN MEMORY through the mutation so the supersede block reads the
  // post-eviction state WITHOUT re-reading the evicted file (one read per mutation).
  let currentEvicted = snap.evicted;

  // positioning
  if (rankingEnabled) {
    let at = 0; // default: top
    if (beforeId != null) {
      const idx = newActive.findIndex((r) => r.id === beforeId);
      if (idx >= 0) at = idx; // before the named id; if filtered-out/not-found, fall back to top
    }
    newActive = [...newActive.slice(0, at), rec, ...newActive.slice(at)];
  } else {
    newActive = [...newActive, rec]; // append to end (arrival order)
  }

  // mechanical tail eviction (ranked only) — extend the in-memory evicted list (no disk re-read)
  if (rankingEnabled && newActive.length > limit) {
    const overflow = newActive.length - limit;
    const tail = newActive.splice(newActive.length - overflow, overflow); // pop least-valuable tail
    if (tiers.evicted) currentEvicted = [...currentEvicted, ...tail];
  }

  writeTier(tiers.active, newActive);

  // supersede: move targeted ids from active OR evicted → dropped ("found wherever it lives").
  // Uses the IN-MEMORY post-eviction `currentEvicted` (no re-read). `snap.dropped` was read once up front.
  if (supersedes.length > 0) {
    const movedFromActive = active.filter((r) => supSet.has(r.id));
    const movedFromEvicted = currentEvicted.filter((r) => supSet.has(r.id));
    const allMoved = [...movedFromActive, ...movedFromEvicted];
    if (allMoved.length > 0) writeTier(tiers.dropped, [...snap.dropped, ...allMoved]);
    if (movedFromEvicted.length > 0 && tiers.evicted) {
      writeTier(
        tiers.evicted,
        currentEvicted.filter((r) => !supSet.has(r.id)),
      );
    } else if (rankingEnabled && tiers.evicted && currentEvicted !== snap.evicted) {
      // eviction extended evicted but no supersede removed from it → write the extended list
      writeTier(tiers.evicted, currentEvicted);
    }
  } else if (rankingEnabled && tiers.evicted && currentEvicted !== snap.evicted) {
    // eviction happened but no supersede — persist the extended evicted list (no re-read)
    writeTier(tiers.evicted, currentEvicted);
  }
  return rec.id;
}

/**
 * SHARED record construction (caller holds the lock). Computes the next id from the pre-read
 * `all` array, filters `supersedes` to ids that actually exist, and builds the `DecisionRecord`.
 * Used by BOTH `applyAdd` (manual, below) and `applyBuild` (auto-catch, build.ts) so the record
 * schema lives in exactly ONE place (no drift between capture modes). `all` is
 * pre-read by the caller (readTierSnapshot) to avoid a redundant read here.
 */
export function buildDecisionRecord(
  all: { id: number }[],
  fields: { summary: string; detail: string },
  supersedes: number[] | null,
  now: Date,
): { rec: DecisionRecord; supersedes: number[] } {
  const id = nextId(all);
  const idSet = new Set(all.map((r) => r.id)); // O(N) once → filter is O(S) total, not O(S×N)
  const filtered = (supersedes ?? []).filter((x) => idSet.has(x));
  const rec: DecisionRecord = {
    id,
    scope: "session",
    supersedes: filtered.length > 0 ? filtered : null,
    timestamp: now.toISOString(),
    summary: fields.summary,
    detail: fields.detail,
  };
  return { rec, supersedes: filtered };
}

/**
 * Agent-driven add under lock (NO LLM). Reads all tiers ONCE, constructs the record via
 * the shared helper, then delegates to `applyInsert` (one write path — no drift between manual
 * and auto-catch writes, ). Returns the new record's id.
 */
export function applyAdd(tiers: TierPaths, input: AddInput, now: Date): AddResult {
  const snap = readTierSnapshot(tiers);
  const all = [...snap.active, ...snap.evicted, ...snap.dropped];
  const { rec: newRec, supersedes } = buildDecisionRecord(all, input, input.supersedes, now);
  applyInsert(tiers, snap, newRec, input.beforeId, supersedes, input.rankingEnabled, input.limit);
  return { id: newRec.id, summary: newRec.summary, superseded: supersedes };
}

/**
 * Render a record as one display line: `{id} {summary}` (NO `#` prefix).
 * Sanitizes newlines/control chars so a malicious or malformed summary can't break the list
 * formatting or inject fake header lines into the injected system-prompt section.
 * Single source of truth for the line format — used by injection + tool renderers (no 5× dup).
 */
export function formatRecordLine(rec: { id: number; summary: string }): string {
  // Sanitize: collapse to one line and strip control chars so a malformed/malicious summary
  // can't break list formatting or inject fake header lines into the injected system prompt.
  // (No control-char regex — biome's noControlCharactersInRegex flags range endpoints)
  const oneLine = rec.summary.replace(/\r?\n|\r/g, " ");
  // Char-by-char scan over code POINTS (surrogate-safe) with no intermediate array.
  // Reject: C0 control chars (< 32; includes tab 9), DEL (127), C1 control 128–159
  // (includes NEL U+0085=133), and the Unicode line separators U+2028/U+2029 — all are
  // line-breaking/formatting chars that could break list formatting.
  const LINE_SEP = new Set([0x2028, 0x2029]);
  let cleaned = "";
  for (let i = 0; i < oneLine.length; ) {
    const c = oneLine.codePointAt(i) ?? 0;
    const isControl = c < 32 || c === 127 || (c >= 128 && c <= 159) || LINE_SEP.has(c);
    if (!isControl) cleaned += c > 0xffff ? oneLine.substr(i, 2) : oneLine[i];
    i += c > 0xffff ? 2 : 1; // advance 2 code units for an astral (surrogate) code point
  }
  return `${rec.id} ${cleaned.trim()}`;
}
