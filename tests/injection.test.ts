// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInjection } from "../src/injection.js";
import { writeTier } from "../src/storage.js";
import type { DecisionRecord, TierPaths } from "../src/types.js";

let dir: string;
let tp: TierPaths;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-injection-"));
  tp = { active: path.join(dir, "s.jsonl"), evicted: null, dropped: path.join(dir, "s.dropped.jsonl") };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

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

function renderOrThrow(tiers: TierPaths, rankingEnabled: boolean, limit: number): string {
  const out = renderInjection(tiers, rankingEnabled, limit);
  if (out === null) throw new Error("expected non-null injection");
  return out;
}

describe("renderInjection — omit-when-empty", () => {
  it("empty active (no file) → null (whole section omitted)", () => {
    expect(renderInjection(tp, true, 20)).toBeNull();
  });

  it("empty active (file exists but empty) → null", () => {
    writeTier(tp.active, []);
    expect(renderInjection(tp, true, 20)).toBeNull();
  });
});

describe("renderInjection — ranked", () => {
  it("returns header with 'ordered by value (most valuable first)' + top limit in file order", () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS), rec(3, NO_DECISION_OPTS)]);
    const out = renderOrThrow(tp, true, 20);
    expect(out).toContain("ordered by value (most valuable first)");
    // file order preserved (top = first = most valuable)
    expect(out).toContain("- 1 decision 1");
    expect(out).toContain("- 2 decision 2");
    expect(out).toContain("- 3 decision 3");
    // file order: 1, 2, 3
    expect(out.indexOf("- 1 ")).toBeLessThan(out.indexOf("- 2 "));
    expect(out.indexOf("- 2 ")).toBeLessThan(out.indexOf("- 3 "));
  });

  it("header is verbatim approved text", () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    const out = renderOrThrow(tp, true, 20);
    expect(out).toMatch(/^## User Decisions \(this session\)\n/);
    expect(out).toContain("Captured user decisions and Q&A, ordered by value (most valuable first).");
    expect(out).toContain("Add new decisions with user_decision_add; recall any not shown here (including superseded)");
    expect(out).toContain("immediately but will NOT appear in this section until the next reload/compaction.");
  });

  it("with >limit records → only top limit in body", () => {
    writeTier(tp.active, [
      rec(1, NO_DECISION_OPTS),
      rec(2, NO_DECISION_OPTS),
      rec(3, NO_DECISION_OPTS),
      rec(4, NO_DECISION_OPTS),
      rec(5, NO_DECISION_OPTS),
    ]);
    const out = renderOrThrow(tp, true, 3);
    expect(out).toContain("- 1 ");
    expect(out).toContain("- 2 ");
    expect(out).toContain("- 3 ");
    expect(out).not.toContain("- 4 ");
    expect(out).not.toContain("- 5 ");
  });
});

describe("renderInjection — not ranked", () => {
  it("header phrase is 'most-recent first' (no 'ordered by value')", () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS)]);
    const out = renderOrThrow(tp, false, 20);
    expect(out).toContain("most-recent first");
    expect(out).not.toContain("ordered by value (most valuable first)");
  });

  it("body is the LAST limit records REVERSED (most-recent first)", () => {
    // file is oldest→newest (1,2,3,4); not-ranked injects last `limit` reversed → most-recent first
    writeTier(tp.active, [
      rec(1, NO_DECISION_OPTS),
      rec(2, NO_DECISION_OPTS),
      rec(3, NO_DECISION_OPTS),
      rec(4, NO_DECISION_OPTS),
    ]);
    const out = renderOrThrow(tp, false, 3);
    // last 3 = [2,3,4], reversed → [4,3,2]
    expect(out).toContain("- 4 ");
    expect(out).toContain("- 3 ");
    expect(out).toContain("- 2 ");
    expect(out).not.toContain("- 1 ");
    // most-recent first: 4 before 3 before 2
    expect(out.indexOf("- 4 ")).toBeLessThan(out.indexOf("- 3 "));
    expect(out.indexOf("- 3 ")).toBeLessThan(out.indexOf("- 2 "));
  });
});
