// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import type { DecisionRecord, DecisionStatus, TierPaths } from "./types.js";

/** Read a tier jsonl. Missing file => [] (file-existence guard). Corrupt line => skipped (NDJSON resilience). */
export function readTier(filePath: string): DecisionRecord[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    // Only ENOENT (missing file) => empty (file-existence guard).
    // Other I/O errors (EACCES/EIO/EISDIR) RE-THROW so they surface instead
    // of silently masking corruption (which could cause id collisions).
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: DecisionRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const rec = parseRecord(obj);
      if (rec) out.push(rec);
    } catch {
      // skip corrupt line (NDJSON resilience)
    }
  }
  return out;
}

/**
 * Count the records in a tier file WITHOUT parsing JSON (cheap line-count for the status bar's
 * TotalActive, which is recomputed on recurring timers — ). Non-empty lines only;
 * ENOENT => 0 (same file-existence guard as readTier). Corrupt-but-non-empty lines still count
 * (the count is an approximation for display; correctness lives in readTier).
 */
export function countRecords(filePath: string): number {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  // Count non-empty lines WITHOUT allocating a lines array (content.split would materialize one
  // this runs on recurring timers against potentially large files, ). Scan chars,
  // tracking whether the current line holds any non-whitespace; bump on each newline when it does.
  let n = 0;
  let lineHasContent = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    if (ch === 0x0a) {
      // \n
      if (lineHasContent) n++;
      lineHasContent = false;
    } else if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0d) {
      // not space/tab/CR → this line has real content
      lineHasContent = true;
    }
  }
  if (lineHasContent) n++; // final line with no trailing newline
  return n;
}

/** Validate a parsed object into a DecisionRecord (or null if malformed). Exported for direct testing. */
export function parseRecord(obj: Record<string, unknown>): DecisionRecord | null {
  if (typeof obj.id !== "number" || !Number.isFinite(obj.id)) return null;
  if (obj.scope !== "session") return null; // v1 is session-only; strict rejection surfaces corruption
  if (typeof obj.timestamp !== "string") return null;
  if (typeof obj.summary !== "string") return null;
  if (typeof obj.detail !== "string") return null;
  let supersedes: number[] | null = null;
  if (Array.isArray(obj.supersedes)) {
    supersedes = obj.supersedes.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  }
  return {
    id: obj.id,
    scope: "session",
    supersedes,
    timestamp: obj.timestamp,
    summary: obj.summary,
    detail: obj.detail,
  };
}

/** Serialize one record (omits supersedes when null or empty, for clean jsonl). */
export function serializeRecord(rec: DecisionRecord): string {
  const obj: Record<string, unknown> = {
    id: rec.id,
    scope: rec.scope,
    timestamp: rec.timestamp,
    summary: rec.summary,
    detail: rec.detail,
  };
  if (rec.supersedes && rec.supersedes.length > 0) obj.supersedes = rec.supersedes;
  return JSON.stringify(obj);
}

/** Atomic write: tmp + rename (readers never see a torn file). */
export function writeTier(filePath: string, records: DecisionRecord[]): void {
  const lines = records.map(serializeRecord).join("\n");
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, lines.length > 0 ? `${lines}\n` : "");
  fs.renameSync(tmp, filePath);
}

/** Next sequential id = max(id across active+evicted+dropped) + 1 (assigned under lock). */
export function nextId(allRecords: { id: number }[]): number {
  let max = 0;
  for (const r of allRecords) if (r.id > max) max = r.id;
  return max + 1;
}

// ---: derived status + supersededBy inversion ---

/** A record tagged with its tier-derived status (read time —: status = which file). */
export interface RecordWithStatus extends DecisionRecord {
  status: DecisionStatus;
}

/** Read all records across tiers, tagging each with its tier-derived status. */
export function readAllTiered(tiers: TierPaths): RecordWithStatus[] {
  const active = readTier(tiers.active).map((r) => ({ ...r, status: "active" as const }));
  const evicted = tiers.evicted ? readTier(tiers.evicted).map((r) => ({ ...r, status: "evicted" as const })) : [];
  const dropped = readTier(tiers.dropped).map((r) => ({ ...r, status: "dropped" as const }));
  return [...active, ...evicted, ...dropped];
}

/** Read the tiers needed for a given list status (: avoid the dropped file read for "live" queries
 * a live record (active/evicted) is never itself superseded, and a dropped record never supersedes
 * a live one, so the dropped tier contributes nothing to live results or their supersede chains). */
export function readTieredForStatus(tiers: TierPaths, status: "live" | "dropped" | "all"): RecordWithStatus[] {
  if (status === "live") {
    const active = readTier(tiers.active).map((r) => ({ ...r, status: "active" as const }));
    const evicted = tiers.evicted ? readTier(tiers.evicted).map((r) => ({ ...r, status: "evicted" as const })) : [];
    return [...active, ...evicted];
  }
  return readAllTiered(tiers);
}

/** Build id -> supersededBy map by inverting every record's supersedes back-references (across all tiers). */
export function buildSupersededByMap(all: RecordWithStatus[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const r of all) {
    if (!r.supersedes) continue;
    for (const oldId of r.supersedes) {
      const list = map.get(oldId) ?? [];
      list.push(r.id);
      map.set(oldId, list);
    }
  }
  return map;
}
