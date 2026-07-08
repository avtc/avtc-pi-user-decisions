// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryDetail, queryList, renderDetailContent, renderListContent } from "../src/render.js";
import { writeTier } from "../src/storage.js";
import type { DecisionRecord, TierPaths } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-render-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function tiers(ranked: boolean): TierPaths {
  const active = path.join(dir, "s1.jsonl");
  return {
    active,
    evicted: ranked ? path.join(dir, "s1.evicted.jsonl") : null,
    dropped: path.join(dir, "s1.dropped.jsonl"),
  };
}

/** Build a record with descending timestamps so id order ≠ recency order (older id = newer time). */
function rec(id: number, opts: Partial<DecisionRecord> | null): DecisionRecord {
  return {
    id,
    scope: "session",
    supersedes: null,
    // HIGHER id → EARLIER time, so most-recent (latest time) is the LOWEST id. Lets us assert
    // not-ranked most-recent-first ordering independently of insertion order.
    timestamp: new Date(Date.now() - id * 1000).toISOString(),
    summary: `decision ${id}`,
    detail: `detail ${id}`,
    ...(opts ?? {}),
  };
}

const NO_OPTS: Partial<DecisionRecord> | null = null;

function seed(file: string, records: DecisionRecord[]): void {
  if (records.length === 0) return;
  writeTier(file, records);
}

describe("renderListContent", () => {
  it("renders one id/summary line per row, no count line", () => {
    const rows = [
      { id: 1, summary: "first", status: "active" as const, timestamp: "t", supersededBy: [] },
      { id: 2, summary: "second", status: "active" as const, timestamp: "t", supersededBy: [1] },
    ];
    const out = renderListContent(rows);
    expect(out).toBe("1 first\n2 second (Superseded by 1)");
  });

  it("active records show no status marker", () => {
    const out = renderListContent([
      { id: 5, summary: "only", status: "active" as const, timestamp: "t", supersededBy: [] },
    ]);
    expect(out).toBe("5 only");
  });
});

describe("renderDetailContent", () => {
  it("renders id/summary, timestamp, supersedes chain, then detail", () => {
    const rec = {
      id: 7,
      summary: "a decision",
      detail: "the rationale\nmore",
      timestamp: "2026-06-23T00:00:00.000Z",
      supersedes: [3, 4],
    };
    const out = renderDetailContent(rec, [9]);
    expect(out).toBe("7 a decision\n2026-06-23T00:00:00.000Z\nSupersedes: 3,4\nSuperseded by: 9\nthe rationale\nmore");
  });

  it("omits supersedes/supersededBy lines when empty", () => {
    const rec = { id: 1, summary: "s", detail: "d", timestamp: "t", supersedes: null };
    const out = renderDetailContent(rec, []);
    expect(out).toBe("1 s\nt\nd");
  });
});

describe("queryList", () => {
  it("ranked: returns live records in file order (value order — top first)", () => {
    const tp = tiers(true);
    seed(tp.active, [rec(1, NO_OPTS), rec(2, NO_OPTS), rec(3, NO_OPTS)]); // 1=most valuable
    const { content, rows } = queryList(tp, true, { status: "live", filter: null, limit: null });
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(content).toContain("1 decision 1");
    expect(content).toContain("3 decision 3");
  });

  it("not-ranked: returns live records MOST-RECENT FIRST (reversed)", () => {
    const tp = tiers(false);
    // Real storage appends chronologically (oldest first). rec(3) is oldest time, rec(1) newest,
    // so a realistic file is [3,2,1] (oldest→newest). Reverse → [1,2,3] = most-recent first.
    seed(tp.active, [rec(3, NO_OPTS), rec(2, NO_OPTS), rec(1, NO_OPTS)]);
    const { rows } = queryList(tp, false, { status: "live", filter: null, limit: null });
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]); // 1 newest, then 2, then 3
  });

  it("status live excludes dropped records", () => {
    const tp = tiers(true);
    seed(tp.active, [rec(1, NO_OPTS)]);
    seed(tp.dropped, [rec(2, NO_OPTS)]); // dropped
    const { rows } = queryList(tp, true, { status: "live", filter: null, limit: null });
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("status all/live/dropped filter correctly across active+evicted+dropped tiers", () => {
    // Seed all three tiers; assert each status filter selects the right subset. This covers the
    // "all" branch (returns everything) + confirms evicted records count as live (active+evicted).
    const tp = tiers(true);
    seed(tp.active, [rec(1, NO_OPTS), rec(2, NO_OPTS)]); // active
    if (!tp.evicted) throw new Error("evicted tier missing for ranked tiers");
    seed(tp.evicted, [rec(3, NO_OPTS)]); // evicted (ranked → evicted path exists)
    seed(tp.dropped, [rec(4, NO_OPTS)]); // dropped

    // live = active + evicted (NOT dropped)
    const live = queryList(tp, true, { status: "live", filter: null, limit: null }).rows.map((r) => r.id);
    expect(live.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(live).not.toContain(4);

    // dropped = dropped tier only
    const dropped = queryList(tp, true, { status: "dropped", filter: null, limit: null }).rows.map((r) => r.id);
    expect(dropped).toEqual([4]);

    // all = active + evicted + dropped (every tier)
    const all = queryList(tp, true, { status: "all", filter: null, limit: null }).rows.map((r) => r.id);
    expect(all.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("filter matches substring across summary and detail (case-insensitive)", () => {
    const tp = tiers(true);
    seed(tp.active, [
      rec(1, { summary: "Use SQLite", detail: "for locking" }),
      rec(2, { summary: "Use Redis", detail: "for cache" }),
    ]);
    const { rows } = queryList(tp, true, { status: "live", filter: "SQLITE", limit: null });
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("empty store → content is '(no decisions)'", () => {
    const tp = tiers(true);
    const { content, rows } = queryList(tp, true, { status: "live", filter: null, limit: null });
    expect(content).toBe("(no decisions)");
    expect(rows).toEqual([]);
  });

  it("limit caps the number of rows", () => {
    const tp = tiers(true);
    seed(tp.active, [rec(1, NO_OPTS), rec(2, NO_OPTS), rec(3, NO_OPTS)]);
    const { rows } = queryList(tp, true, { status: "live", filter: null, limit: 2 });
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("queryDetail", () => {
  it("found: returns the record + supersede chain", () => {
    const tp = tiers(true);
    seed(tp.active, [rec(1, { summary: "alpha", detail: "why" })]);
    const res = queryDetail(tp, 1);
    expect(res.found).toBe(true);
    if (res.found) {
      expect(res.content).toContain("1 alpha");
      expect(res.content).toContain("why");
      expect(res.rec.id).toBe(1);
      expect(res.rec.summary).toBe("alpha");
    }
  });

  it("missing id → found false", () => {
    const tp = tiers(true);
    const res = queryDetail(tp, 999);
    expect(res.found).toBe(false);
  });
});
