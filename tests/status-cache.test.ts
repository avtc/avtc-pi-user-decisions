// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Dedicated file for the mtime-cache tests.
// These tests exercise the REAL countRecords (no vi.mock interception) and control cache hit/miss
// via file CONTENT + forced mtime. This is deterministic regardless of vitest's `isolate: false`
// module-load ordering: relying on a vi.mock spy to intercept status.ts's already-bound countRecords
// import is fragile under the shared module cache (the spy is sometimes bypassed). Asserting on the
// observable cache behavior (stale count on hit, fresh count on miss) is both stronger and order-proof.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countTotalActive, invalidateCountCache } from "../src/status.js";
import { writeTier } from "../src/storage.js";
import type { TierPaths } from "../src/types.js";

let dir: string;
let tp: TierPaths;
const rec = (id: number) => ({
  id,
  scope: "session" as const,
  supersedes: null,
  timestamp: "t",
  summary: "s",
  detail: "d",
});

/** Floors the file's mtime exactly like status.ts's cache does (the cache compares floor(mtimeMs)). */
function floorMtime(filePath: string): number {
  return Math.floor(fs.statSync(filePath).mtimeMs);
}

/** Force the file's mtime to a specific ms value (round-trips on win32/linux/macOS for distinct
 * integer-ms values). Used to simulate "same mtime, different content" deterministically. */
function forceMtime(filePath: string, mtimeMs: number): void {
  const d = new Date(mtimeMs);
  fs.utimesSync(filePath, d, d);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-status-cache-"));
  tp = {
    active: path.join(dir, "s.jsonl"),
    evicted: path.join(dir, "s.evicted.jsonl"),
    dropped: path.join(dir, "s.dropped.jsonl"),
  };
  invalidateCountCache();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("mtime cache", () => {
  it("skips the file read when mtime is unchanged → serves the STALE cached count (cache hit)", () => {
    writeTier(tp.active, [rec(1), rec(2)]);
    expect(countTotalActive(tp)).toBe(2); // first count → cache miss → reads file (2 records)
    const cachedMtime = floorMtime(tp.active);

    // Mutate the file content to 3 records, then force the mtime BACK to the cached value.
    // A cache hit must serve the STALE count (2), NOT the new on-disk content (3).
    writeTier(tp.active, [rec(1), rec(2), rec(3)]);
    forceMtime(tp.active, cachedMtime);

    expect(countTotalActive(tp)).toBe(2); // stale → cache hit served the old count, not 3
  });

  it("re-reads when the mtime changes → serves the FRESH count (cache miss)", () => {
    writeTier(tp.active, [rec(1)]);
    expect(countTotalActive(tp)).toBe(1); // cold cache → reads file (1 record)
    const firstMtime = floorMtime(tp.active);

    // A real write bumps the mtime → cache must miss → fresh read of the new content (2 records).
    writeTier(tp.active, [rec(1), rec(2)]);
    // Guard against a same-ms mtime collision (two back-to-back writes can share an mtime tick):
    // if the second write didn't advance the ms, force a strictly-later mtime so the cache misses.
    if (floorMtime(tp.active) <= firstMtime) {
      forceMtime(tp.active, firstMtime + 1000);
    }

    expect(countTotalActive(tp)).toBe(2); // fresh read (mtime bumped → cache miss)
  });

  it("ENOENT returns 0 without throwing (both tiers absent)", () => {
    expect(countTotalActive(tp)).toBe(0); // active + evicted both absent
  });

  it("invalidateCountCache forces a fresh read even when the mtime is unchanged", () => {
    writeTier(tp.active, [rec(1), rec(2)]);
    expect(countTotalActive(tp)).toBe(2); // cache miss → reads (2)
    const cachedMtime = floorMtime(tp.active);

    // Change content + force the SAME mtime: without invalidation this would be a cache hit (stale 2).
    writeTier(tp.active, [rec(1), rec(2), rec(3), rec(4)]);
    forceMtime(tp.active, cachedMtime);
    expect(countTotalActive(tp)).toBe(2); // still cached (hit) → confirms the setup holds

    invalidateCountCache();
    expect(countTotalActive(tp)).toBe(4); // invalidated → forced re-read → fresh count (4)
  });

  it("counts active + evicted together (evicted tier present)", () => {
    writeTier(tp.active, [rec(1), rec(2)]);
    if (!tp.evicted) throw Error("evicted tier missing");
    writeTier(tp.evicted, [rec(3)]);
    expect(countTotalActive(tp)).toBe(3); // 2 active + 1 evicted
  });
});
