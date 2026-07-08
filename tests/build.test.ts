// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBuild, type Candidate } from "../src/build.js";
import { applyInsert, readTierSnapshot } from "../src/decisions.js";
import { readTier } from "../src/storage.js";
import type { DecisionRecord, TierPaths } from "../src/types.js";

let dir: string;
let now: Date;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-build-"));
  now = new Date("2026-06-22T00:00:00Z");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Tiers with ranking enabled */
const TIERED_RANKED = true;

/** Tiers without ranking */
const TIERED_UNRANKED = false;

function tiers(ranked: boolean): TierPaths {
  const active = path.join(dir, "s.jsonl");
  return {
    active,
    evicted: ranked ? active.replace(/\.jsonl$/, ".evicted.jsonl") : null,
    dropped: active.replace(/\.jsonl$/, ".dropped.jsonl"),
  };
}

function evictedPath(tp: TierPaths): string {
  if (!tp.evicted) throw new Error("ranked runtime must have an evicted path");
  return tp.evicted;
}

function rec(id: number, opts: Partial<DecisionRecord> | null): DecisionRecord {
  return {
    id,
    scope: "session",
    supersedes: null,
    timestamp: new Date(Date.now() - (100 - id) * 1000).toISOString(),
    summary: `decision ${id}`,
    detail: `detail ${id}`,
    ...(opts ?? {}),
  };
}

/** No decision record options (use defaults) */
const NO_DECISION_OPTS: Partial<DecisionRecord> | null = null;

function seed(file: string, records: DecisionRecord[]): void {
  if (records.length === 0) return;
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function activeIds(tp: TierPaths): number[] {
  return readTier(tp.active).map((r) => r.id);
}

const CANDIDATE: Candidate = { summary: "new decision", detail: "new detail" };

describe("applyBuild — insert", () => {
  it("ranked insert without beforePosition → appends at TOP (most valuable)", () => {
    const tp = tiers(TIERED_RANKED);
    seed(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS), rec(3, NO_DECISION_OPTS)]);
    const id = applyBuild(
      tp,
      CANDIDATE,
      { action: "insert", beforePosition: null, supersedes: null },
      true,
      20,
      now,
      null,
    );
    expect(id).toBe(4);
    expect(activeIds(tp)).toEqual([4, 1, 2, 3]); // top
  });

  it("ranked insert with beforePosition → inserts before that id", () => {
    const tp = tiers(TIERED_RANKED);
    seed(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS), rec(3, NO_DECISION_OPTS)]);
    applyBuild(tp, CANDIDATE, { action: "insert", beforePosition: 2, supersedes: null }, true, 20, now, null);
    expect(activeIds(tp)).toEqual([1, 4, 2, 3]); // before #2
  });

  it("not-ranked insert → appends at END (no positioning, no eviction)", () => {
    const tp = tiers(TIERED_UNRANKED);
    seed(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS)]);
    applyBuild(tp, CANDIDATE, { action: "insert", beforePosition: 999, supersedes: null }, false, 20, now, null);
    // beforePosition ignored in not-ranked mode; appends to end
    expect(activeIds(tp)).toEqual([1, 2, 3]);
  });
});

describe("applyBuild — supersede", () => {
  it("supersede moves old record to dropped; new carries supersedes back-ref", () => {
    const tp = tiers(TIERED_RANKED);
    seed(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS)]);
    const id = applyBuild(
      tp,
      CANDIDATE,
      { action: "supersede", beforePosition: null, supersedes: [1] },
      true,
      20,
      now,
      null,
    );
    expect(id).toBe(3);
    expect(activeIds(tp)).toEqual([3, 2]); // 1 superseded → dropped; new at top
    expect(readTier(tp.dropped).map((r) => r.id)).toEqual([1]);
    // new record carries the supersedes back-ref
    const newRec = readTier(tp.active).find((r) => r.id === 3);
    expect(newRec?.supersedes).toEqual([1]);
  });

  it("insert action with supersedes field → ignored (only supersede action uses supersedes)", () => {
    const tp = tiers(TIERED_RANKED);
    seed(tp.active, [rec(1, NO_DECISION_OPTS)]);
    applyBuild(tp, CANDIDATE, { action: "insert", beforePosition: null, supersedes: [1] }, true, 20, now, null);
    // insert ignores supersedes — record 1 stays active, new appended at top
    expect(activeIds(tp)).toEqual([2, 1]);
    expect(readTier(tp.dropped)).toHaveLength(0);
  });

  it("supersede of a non-existent id → filtered out (no supersede, just insert at top)", () => {
    const tp = tiers(TIERED_RANKED);
    seed(tp.active, [rec(1, NO_DECISION_OPTS)]);
    applyBuild(tp, CANDIDATE, { action: "supersede", beforePosition: null, supersedes: [999] }, true, 20, now, null);
    expect(activeIds(tp)).toEqual([2, 1]); // 999 didn't exist; new at top, 1 still active
    expect(readTier(tp.dropped)).toHaveLength(0);
  });
});

describe("applyBuild — mechanical tail eviction", () => {
  it("ranked insert past limit → tail evicted to evicted tier", () => {
    const tp = tiers(TIERED_RANKED);
    seed(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS), rec(3, NO_DECISION_OPTS)]); // limit=3
    applyBuild(tp, CANDIDATE, { action: "insert", beforePosition: null, supersedes: null }, true, 3, now, null);
    expect(activeIds(tp)).toEqual([4, 1, 2]); // 3 evicted (tail)
    expect(readTier(evictedPath(tp)).map((r) => r.id)).toEqual([3]);
  });

  it("not-ranked never evicts (limit ignored in not-ranked mode)", () => {
    const tp = tiers(TIERED_UNRANKED);
    seed(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS), rec(3, NO_DECISION_OPTS)]); // limit=3
    applyBuild(tp, CANDIDATE, { action: "insert", beforePosition: null, supersedes: null }, false, 3, now, null);
    expect(activeIds(tp)).toEqual([1, 2, 3, 4]); // nothing evicted, appended
    expect(readTier(tp.dropped)).toHaveLength(0);
  });
});

describe("applyBuild — skip is a defensive no-op", () => {
  it("action='skip' returns the would-be id WITHOUT writing (caller guards skip, but applyBuild is defensive)", () => {
    const tp = tiers(true);
    seed(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS)]);
    const id = applyBuild(
      tp,
      CANDIDATE,
      { action: "skip", beforePosition: null, supersedes: null },
      true,
      20,
      now,
      null,
    );
    expect(id).toBe(3); // next id, but nothing written
    expect(activeIds(tp)).toEqual([1, 2]); // store unchanged
    expect(readTier(tp.dropped)).toHaveLength(0);
    expect(readTier(evictedPath(tp))).toHaveLength(0);
  });
});

describe("applyBuild shares applyInsert with applyAdd (DRY)", () => {
  it("builder (beforePosition) and agent (beforeId) produce identical store state", () => {
    // Two identical stores; applyBuild (builder path) on one, applyInsert (agent path) on the other.
    const storeA = tiers(TIERED_RANKED);
    const storeB = tiers(TIERED_RANKED);
    seed(storeA.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS), rec(3, NO_DECISION_OPTS)]);
    seed(storeB.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS), rec(3, NO_DECISION_OPTS)]);
    // builder path
    applyBuild(storeA, CANDIDATE, { action: "insert", beforePosition: 2, supersedes: null }, true, 20, now, null);
    // agent path: same positioning (beforeId=2)
    // agent path: same positioning (beforeId=2). Pass a fresh snapshot (single read per mutation).
    applyInsert(
      storeB,
      readTierSnapshot(storeB),
      {
        id: 4,
        scope: "session",
        supersedes: null,
        timestamp: now.toISOString(),
        summary: CANDIDATE.summary,
        detail: CANDIDATE.detail,
      },
      2,
      [],
      true,
      20,
    );
    expect(activeIds(storeA)).toEqual(activeIds(storeB));
  });
});
