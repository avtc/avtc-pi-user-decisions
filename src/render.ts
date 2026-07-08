// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Shared content renderers + read-only query helpers for the decision store.
 *
 * Used by BOTH the agent tools (`tools.ts`) and the user slash commands (`commands.ts`) so the
 * text layout is identical wherever a decision list/detail is shown ( rendering +
 * the `/user-decisions:list`/`/user-decisions:details` commands). Reads are lock-free (read-only;
 * the same way `user_decision_list`/`user_decision_detail` read).
 */
import { formatRecordLine } from "./decisions.js";
import { buildSupersededByMap, type RecordWithStatus, readAllTiered, readTieredForStatus } from "./storage.js";
import type { DecisionStatus, TierPaths } from "./types.js";

export type ListStatus = "live" | "dropped" | "all";

export interface ListQueryOptions {
  status: ListStatus;
  /** Substring filter (case-insensitive across summary + detail). null/undefined = no filter. */
  filter: string | null;
  /** Cap on the number of rows. null/undefined = no cap. */
  limit: number | null;
}

/** A list row as produced by `queryList` / consumed by `renderListContent`. */
export interface ListRow {
  id: number;
  summary: string;
  status: DecisionStatus;
  timestamp: string;
  supersededBy: number[];
}

/** user_decision_list — content = the ORDERED list, no count line. Active records show no status marker. */
export function renderListContent(rows: ListRow[]): string {
  return rows
    .map((r) => {
      let line = formatRecordLine(r);
      if (r.supersededBy.length > 0) line += ` (Superseded by ${r.supersededBy.join(",")})`;
      return line; // no status marker for active
    })
    .join("\n");
}

/** user_decision_detail — content = full record (id/summary/timestamp/chain/detail). */
export function renderDetailContent(
  rec: { id: number; summary: string; detail: string; timestamp: string; supersedes: number[] | null },
  supersededBy: number[],
): string {
  const lines = [formatRecordLine(rec), rec.timestamp]; // ISO 8601 UTC
  if (rec.supersedes && rec.supersedes.length > 0) lines.push(`Supersedes: ${rec.supersedes.join(",")}`);
  if (supersededBy.length > 0) lines.push(`Superseded by: ${supersededBy.join(",")}`);
  lines.push(rec.detail);
  return lines.join("\n");
}

/** Order records per the ranking setting (applies to any status filter — not just "live"):
 *  - ranked: file order (value order — top = most valuable, already correct in storage).
 *  - not-ranked: most-recent first (reverse file order — records append to the end, so file order
 *  is oldest-first; the documented list order for not-ranked is most-recent first). */
function orderRecords(records: RecordWithStatus[], rankingEnabled: boolean): RecordWithStatus[] {
  return rankingEnabled ? records : [...records].reverse();
}

/**
 * Read + filter + order the decision store into display rows + rendered content. Mirrors the
 * `user_decision_list` tool exactly (status filter FIRST — cheap — before the summary+detail scan).
 */
export function queryList(
  tiers: TierPaths,
  rankingEnabled: boolean,
  opts: ListQueryOptions,
): { rows: ListRow[]; content: string } {
  const all = readTieredForStatus(tiers, opts.status);
  const supersededByMap = buildSupersededByMap(all);
  const needle = opts.filter ? opts.filter.toLowerCase() : null; // hoist out of the per-record loop (perf)
  const filtered = all.filter((rec) => {
    if (opts.status === "live" && rec.status === "dropped") return false;
    if (opts.status === "dropped" && rec.status !== "dropped") return false;
    if (needle && !`${rec.summary} ${rec.detail}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const ordered = orderRecords(filtered, rankingEnabled);
  const capped = opts.limit != null ? ordered.slice(0, opts.limit) : ordered;
  const rows: ListRow[] = capped.map((rec) => ({
    id: rec.id,
    summary: rec.summary,
    status: rec.status,
    timestamp: rec.timestamp,
    supersededBy: supersededByMap.get(rec.id) ?? [],
  }));
  const content = rows.length > 0 ? renderListContent(rows) : "(no decisions)";
  return { rows, content };
}

/** Read a single decision by id (any tier) for detail display. `found: false` when missing. */
export function queryDetail(
  tiers: TierPaths,
  id: number,
): { found: true; content: string; rec: RecordWithStatus; supersededBy: number[] } | { found: false } {
  const all = readAllTiered(tiers);
  const rec = all.find((x) => x.id === id);
  if (!rec) return { found: false };
  // One-pass scan for the single id: only records that `supersedes` this id matter, so a
  // full inversion (buildSupersededByMap — a Map + fresh array per superseded id) is overkill for a
  // point lookup. queryList still uses buildSupersededByMap where the whole column is needed.
  const supersededBy = all.filter((x) => x.supersedes?.includes(rec.id)).map((x) => x.id);
  return { found: true, content: renderDetailContent(rec, supersededBy), rec, supersededBy };
}
