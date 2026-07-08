// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countTotalActive, invalidateCountCache, renderStatus, snapshot } from "../src/status.js";
import { writeTier } from "../src/storage.js";
import type { DecisionRecord, DecisionsConfig, TierPaths } from "../src/types.js";

let dir: string;
let tp: TierPaths;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-status-"));
  const active = path.join(dir, "s.jsonl");
  tp = { active, evicted: path.join(dir, "s.evicted.jsonl"), dropped: path.join(dir, "s.dropped.jsonl") };
  invalidateCountCache(); // isolate mtime-cache state between tests
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rec(id: number): DecisionRecord {
  return {
    id,
    scope: "session",
    supersedes: null,
    timestamp: new Date().toISOString(),
    summary: `decision ${id}`,
    detail: `detail ${id}`,
  };
}

const MANUAL: DecisionsConfig = {
  captureMode: "agent",
  backgroundCaptureModel: null,
  rankingEnabled: true,
  injectIntoSystemPromptEnabled: true,
  limit: 100,
  backgroundRetries: 3,
  backgroundThinkingLevel: "low",
  backgroundMaxTokens: 8192,
  backgroundCallTimeoutMs: 180_000,
  backgroundCaptureDumpLimit: 30,
};
const AUTO: DecisionsConfig = { ...MANUAL, captureMode: "background" };

describe("countTotalActive", () => {
  it("counts active + evicted, excludes dropped", () => {
    writeTier(tp.active, [rec(1), rec(2), rec(3)]);
    writeTier(tp.evicted as string, [rec(4)]);
    writeTier(tp.dropped, [rec(5), rec(6)]);
    expect(countTotalActive(tp)).toBe(4); // 3 active + 1 evicted
  });

  it("empty tiers → 0", () => {
    expect(countTotalActive(tp)).toBe(0);
  });

  it("evicted null (not ranked) → counts active only", () => {
    const notRanked: TierPaths = { ...tp, evicted: null };
    writeTier(notRanked.active, [rec(1), rec(2)]);
    expect(countTotalActive(notRanked)).toBe(2);
  });
});

describe("renderStatus", () => {
  it("manual mode → Q&A:{N} always (no segments)", () => {
    expect(renderStatus(MANUAL, { totalActive: 4, queued: 2, tokens: 99, words: 0, paused: true }, false)).toBe(
      "Q&A:4",
    );
  });

  it("auto idle (queued 0, not streaming) → Q&A:{N}", () => {
    expect(renderStatus(AUTO, { totalActive: 4, queued: 0, tokens: 0, words: 0, paused: false }, false)).toBe("Q&A:4");
  });

  it("auto queued>0 → Q&A:{N}·{n}🔜", () => {
    expect(renderStatus(AUTO, { totalActive: 4, queued: 1, tokens: 0, words: 0, paused: false }, false)).toBe(
      "Q&A:4·1🔜",
    );
  });

  it("auto streaming with tokens → Q&A:{N}·1🔜·{tok} tok", () => {
    expect(renderStatus(AUTO, { totalActive: 4, queued: 0, tokens: 42, words: 0, paused: false }, true)).toBe(
      "Q&A:4·1🔜·42 tok",
    );
  });

  it("auto streaming with words (no provider usage) → Q&A:{N}·1🔜·{words} words", () => {
    expect(renderStatus(AUTO, { totalActive: 4, queued: 0, tokens: 0, words: 15, paused: false }, true)).toBe(
      "Q&A:4·1🔜·15 words",
    );
  });

  it("auto streaming with tokens prefers tok over w", () => {
    expect(renderStatus(AUTO, { totalActive: 4, queued: 0, tokens: 42, words: 15, paused: false }, true)).toBe(
      "Q&A:4·1🔜·42 tok",
    );
  });

  it("auto streaming but 0 tokens and 0 words → shows 🔜 but not the tok/w segment", () => {
    expect(renderStatus(AUTO, { totalActive: 4, queued: 0, tokens: 0, words: 0, paused: false }, true)).toBe(
      "Q&A:4·1🔜",
    );
  });

  it("auto paused → adds ·⏸️", () => {
    expect(renderStatus(AUTO, { totalActive: 4, queued: 1, tokens: 0, words: 0, paused: true }, false)).toBe(
      "Q&A:4·1🔜·⏸️",
    );
  });

  it("manual mode ignores stale paused flag (no ⏸️)", () => {
    expect(renderStatus(MANUAL, { totalActive: 4, queued: 0, tokens: 0, words: 0, paused: true }, false)).toBe("Q&A:4");
  });
});

describe("snapshot (integration glue)", () => {
  it("totalActive = active + evicted; paused=false when no pause-state file (auto)", () => {
    writeTier(tp.active, [rec(1), rec(2)]);
    const evictedPath = tp.evicted ?? ""; // tp fixture always sets evicted (ranked)
    if (evictedPath) writeTier(evictedPath, [rec(3)]);
    const snap = snapshot(AUTO, tp, tp.active, 3, 42, 0, null, null);
    expect(snap.totalActive).toBe(3); // 2 active + 1 evicted
    expect(snap.queued).toBe(3);
    expect(snap.tokens).toBe(42);
    expect(snap.paused).toBe(false);
  });

  it("paused=true when a pause-state file exists (auto mode)", () => {
    writeTier(tp.active, [rec(1)]);
    fs.writeFileSync(path.join(dir, "s.state.json"), JSON.stringify({ paused: true, pausedAt: 1, pausedBy: 2 }));
    expect(snapshot(AUTO, tp, tp.active, 0, 0, 0, null, null).paused).toBe(true);
  });

  it("manual mode ignores persisted pause (paused always false)", () => {
    fs.writeFileSync(path.join(dir, "s.state.json"), JSON.stringify({ paused: true, pausedAt: 1, pausedBy: 2 }));
    expect(snapshot(MANUAL, tp, tp.active, 0, 0, 0, null, null).paused).toBe(false);
  });

  it("empty store → totalActive 0", () => {
    expect(snapshot(AUTO, tp, tp.active, 0, 0, 0, 0, null).totalActive).toBe(0);
  });
});
