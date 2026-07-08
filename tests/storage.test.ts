// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSupersededByMap,
  countRecords,
  nextId,
  parseRecord,
  readAllTiered,
  readTier,
  serializeRecord,
  writeTier,
} from "../src/storage.js";
import type { DecisionRecord, TierPaths } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-storage-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rec(id: number, opts: Partial<DecisionRecord> | null): DecisionRecord {
  return {
    id,
    scope: "session",
    supersedes: null,
    timestamp: "2026-06-22T00:00:00.000Z",
    summary: `decision ${id}`,
    detail: `detail ${id}`,
    ...(opts ?? {}),
  };
}

/** No decision record options (use defaults) */
const NO_DECISION_OPTS: Partial<DecisionRecord> | null = null;

function tierPaths(ranked: boolean): TierPaths {
  const active = path.join(dir, "s1.jsonl");
  return {
    active,
    evicted: ranked ? path.join(dir, "s1.evicted.jsonl") : null,
    dropped: path.join(dir, "s1.dropped.jsonl"),
  };
}

describe("storage — : read/write/parse/serialize", () => {
  it("round-trip: write records then read them back equals input (supersedes omitted when null)", () => {
    const file = path.join(dir, "active.jsonl");
    const records = [
      rec(1, { summary: "first" }),
      rec(2, { supersedes: [1], summary: "second replaces first" }),
      rec(3, { summary: "third" }),
    ];
    writeTier(file, records);
    const back = readTier(file);
    expect(back).toHaveLength(3);
    expect(back[0]).toEqual(rec(1, { summary: "first" }));
    expect(back[1]).toEqual(rec(2, { supersedes: [1], summary: "second replaces first" }));
    expect(back[2]).toEqual(rec(3, { summary: "third" }));
  });

  it("serializeRecord omits supersedes when null AND when empty array", () => {
    const noSup = serializeRecord(rec(1, NO_DECISION_OPTS));
    expect(noSup).not.toContain("supersedes");
    const emptySup = serializeRecord(rec(2, { supersedes: [] }));
    expect(emptySup).not.toContain("supersedes");
    const withSup = serializeRecord(rec(3, { supersedes: [1, 2] }));
    expect(withSup).toContain('"supersedes":[1,2]');
  });

  it("readTier on a missing file returns [] (no throw)", () => {
    const missing = path.join(dir, "does-not-exist.jsonl");
    expect(readTier(missing)).toEqual([]);
  });

  it("readTier skips a corrupt line but keeps the rest", () => {
    const file = path.join(dir, "mixed.jsonl");
    const good1 = serializeRecord(rec(1, { summary: "good-1" }));
    const good2 = serializeRecord(rec(2, { summary: "good-2" }));
    const content = `${good1}\nthis is not valid json\n${good2}\n{"id":3}\n`;
    fs.writeFileSync(file, content);
    const back = readTier(file);
    expect(back).toHaveLength(2);
    expect(back[0].summary).toBe("good-1");
    expect(back[1].summary).toBe("good-2");
  });

  it("readTier on a directory (EISDIR, non-ENOENT error) RE-THROWS, not silently empty", () => {
    // readTier must only swallow ENOENT; other I/O errors must surface
    // to avoid masking corruption / id collisions. EISDIR: filePath is a directory.
    const dirPath = path.join(dir, "i-am-a-dir");
    fs.mkdirSync(dirPath);
    expect(() => readTier(dirPath)).toThrow();
  });

  it("parseRecord returns null for malformed shapes (non-number id, missing fields)", () => {
    expect(parseRecord({ id: "x", scope: "session" })).toBeNull();
    expect(parseRecord({ id: 5, scope: 123, timestamp: "t", summary: "s", detail: "d" })).toBeNull();
    expect(parseRecord({ id: 5, scope: "session", timestamp: "t", summary: "s", detail: "d" })).not.toBeNull();
    // non-finite id
    expect(parseRecord({ id: Infinity, scope: "session", timestamp: "t", summary: "s", detail: "d" })).toBeNull();
    // non-string scope (wrong type)
    expect(parseRecord({ id: 5, scope: true, timestamp: "t", summary: "s", detail: "d" })).toBeNull();
    // foreign scope value (v1 is session-only — strict rejection surfaces corruption)
    expect(parseRecord({ id: 5, scope: "project", timestamp: "t", summary: "s", detail: "d" })).toBeNull();
  });

  it("parseRecord filters non-number entries from supersedes array", () => {
    const r = parseRecord({
      id: 9,
      scope: "session",
      timestamp: "t",
      summary: "s",
      detail: "d",
      supersedes: [1, "x", 2, null, 3],
    });
    expect(r?.supersedes).toEqual([1, 2, 3]);
  });

  it("nextId returns max+1 across a mixed set; nextId([]) === 1", () => {
    expect(nextId([])).toBe(1);
    expect(nextId([rec(1, NO_DECISION_OPTS), rec(5, NO_DECISION_OPTS), rec(3, NO_DECISION_OPTS)])).toBe(6);
    expect(nextId([rec(100, NO_DECISION_OPTS)])).toBe(101);
  });

  it("writeTier writes trailing newline and handles empty record set", () => {
    const file = path.join(dir, "empty.jsonl");
    writeTier(file, []);
    // file should exist (atomic write creates it) and be empty
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("");
    expect(readTier(file)).toEqual([]);
  });
});

describe("storage — : derived status + supersededBy inversion", () => {
  it("readAllTiered tags records by which file they are in (ranked: active/evicted/dropped)", () => {
    const tp = tierPaths(true);
    const evictedPath = tp.evicted;
    if (!evictedPath) throw new Error("ranked tierPaths must have an evicted path");
    writeTier(tp.active, [rec(1, { summary: "a1" }), rec(2, { summary: "a2" })]);
    writeTier(evictedPath, [rec(3, { summary: "ev1" })]);
    writeTier(tp.dropped, [rec(4, { summary: "dr1" })]);

    const all = readAllTiered(tp);
    expect(all).toHaveLength(4);
    const byId = new Map(all.map((r) => [r.id, r]));
    expect(byId.get(1)?.status).toBe("active");
    expect(byId.get(2)?.status).toBe("active");
    expect(byId.get(3)?.status).toBe("evicted");
    expect(byId.get(4)?.status).toBe("dropped");
  });

  it("readAllTiered with evicted===null (not-ranked) yields active + dropped only", () => {
    const tp = tierPaths(false);
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    writeTier(tp.dropped, [rec(2, NO_DECISION_OPTS)]);
    const all = readAllTiered(tp);
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.status === "active" || r.status === "dropped")).toBe(true);
    expect(all.some((r) => r.status === "evicted")).toBe(false);
  });

  it("readAllTiered on a fresh session (no files) returns []", () => {
    const tp = tierPaths(true);
    expect(readAllTiered(tp)).toEqual([]);
  });

  it("buildSupersededByMap: record #5 with supersedes:[3] → map has 3 -> [5]", () => {
    const synthetic: ReturnType<typeof readAllTiered> = [
      { ...rec(3, NO_DECISION_OPTS), status: "dropped" as const },
      { ...rec(5, { supersedes: [3] }), status: "active" as const },
    ];
    const map = buildSupersededByMap(synthetic);
    expect(map.get(3)).toEqual([5]);
    expect(map.has(5)).toBe(false);
  });

  it("buildSupersededByMap: multiple replacers union into a list", () => {
    const synthetic: ReturnType<typeof readAllTiered> = [
      { ...rec(3, NO_DECISION_OPTS), status: "dropped" as const },
      { ...rec(5, { supersedes: [3] }), status: "active" as const },
      { ...rec(7, { supersedes: [3, 5] }), status: "active" as const },
    ];
    const map = buildSupersededByMap(synthetic);
    expect(map.get(3)).toEqual([5, 7]);
    expect(map.get(5)).toEqual([7]);
  });

  it("buildSupersededByMap: records with no supersedes contribute nothing", () => {
    const synthetic: ReturnType<typeof readAllTiered> = [
      { ...rec(1, NO_DECISION_OPTS), status: "active" as const },
      { ...rec(2, NO_DECISION_OPTS), status: "active" as const },
    ];
    expect(buildSupersededByMap(synthetic).size).toBe(0);
  });
});

describe("countRecords — no-alloc line count", () => {
  const file = () => path.join(dir, "active.jsonl");

  it("ENOENT => 0 (file does not exist)", () => {
    expect(countRecords(file())).toBe(0);
  });

  it("counts records written by writeTier (trailing newline present)", () => {
    writeTier(file(), [rec(1, { summary: "a" }), rec(2, { summary: "b" }), rec(3, { summary: "c" })]);
    expect(countRecords(file())).toBe(3);
  });

  it("counts a final line with NO trailing newline", () => {
    fs.writeFileSync(file(), '{"id":1}\n{"id":2}'); // no trailing \n on the second line
    expect(countRecords(file())).toBe(2);
  });

  it("skips blank and whitespace-only lines", () => {
    // 3 real records interleaved with blank + whitespace-only + CRLF lines
    fs.writeFileSync(file(), '{"id":1}\n\n   \n{"id":2}\r\n{"id":3}\n\n');
    expect(countRecords(file())).toBe(3);
  });

  it("empty file => 0", () => {
    fs.writeFileSync(file(), "");
    expect(countRecords(file())).toBe(0);
  });

  it("on a directory (EISDIR, non-ENOENT error) RE-THROWS, not silently 0", () => {
    // countRecords must only swallow ENOENT; other I/O errors must surface to avoid
    // masking corruption. EISDIR: filePath is a directory. Mirrors the readTier EISDIR contract.
    const dirPath = path.join(dir, "i-am-a-dir");
    fs.mkdirSync(dirPath);
    expect(() => countRecords(dirPath)).toThrow();
  });
});
