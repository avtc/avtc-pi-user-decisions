// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetailsCommand, runListCommand } from "../src/commands.js";
import { writeTier } from "../src/storage.js";
import type { ToolRuntime } from "../src/tools.js";
import type { DecisionRecord, TierPaths } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-commands-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runtime(ranked: boolean): ToolRuntime {
  const active = path.join(dir, "s1.jsonl");
  const tiers: TierPaths = {
    active,
    evicted: ranked ? path.join(dir, "s1.evicted.jsonl") : null,
    dropped: path.join(dir, "s1.dropped.jsonl"),
  };
  return {
    config: { rankingEnabled: ranked } as ToolRuntime["config"],
    tiers,
    lockState: { abort: new AbortController().signal } as unknown as ToolRuntime["lockState"],
    lockFilePath: path.join(dir, "s1.lock.sqlite"),
  };
}

function rec(id: number, opts: Partial<DecisionRecord> | null): DecisionRecord {
  return {
    id,
    scope: "session",
    supersedes: null,
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

describe("runListCommand", () => {
  it("no args → lists all live decisions", () => {
    const rt = runtime(true);
    seed(rt.tiers.active, [rec(1, NO_OPTS), rec(2, NO_OPTS)]);
    const res = runListCommand(rt, "");
    expect(res.error).toBe(false);
    expect(res.text).toContain("1 decision 1");
    expect(res.text).toContain("2 decision 2");
  });

  it("substring arg → filters (case-insensitive)", () => {
    const rt = runtime(true);
    seed(rt.tiers.active, [
      rec(1, { summary: "Use SQLite", detail: "for locking" }),
      rec(2, { summary: "Use Redis", detail: "for cache" }),
    ]);
    const res = runListCommand(rt, "  SQLITE  ");
    expect(res.error).toBe(false);
    expect(res.text).toContain("1 Use SQLite");
    expect(res.text).not.toContain("Redis");
  });

  it("empty store → shows '(no decisions)'", () => {
    const rt = runtime(true);
    const res = runListCommand(rt, "");
    expect(res.text).toBe("(no decisions)");
    expect(res.error).toBe(false);
  });

  it("excludes dropped records", () => {
    const rt = runtime(true);
    seed(rt.tiers.active, [rec(1, NO_OPTS)]);
    seed(rt.tiers.dropped, [rec(2, NO_OPTS)]);
    const res = runListCommand(rt, "");
    expect(res.text).toContain("1 decision 1");
    expect(res.text).not.toContain("2 decision 2");
  });
});

describe("runDetailsCommand", () => {
  it("valid id → full record", () => {
    const rt = runtime(true);
    seed(rt.tiers.active, [rec(7, { summary: "alpha", detail: "the rationale" })]);
    const res = runDetailsCommand(rt, "7");
    expect(res.error).toBe(false);
    expect(res.text).toContain("7 alpha");
    expect(res.text).toContain("the rationale");
  });

  it("missing id → error message", () => {
    const rt = runtime(true);
    const res = runDetailsCommand(rt, "999");
    expect(res.error).toBe(true);
    expect(res.text).toContain("999");
  });

  it("non-numeric id → error message", () => {
    const rt = runtime(true);
    const res = runDetailsCommand(rt, "abc");
    expect(res.error).toBe(true);
  });

  it("no arg → error message", () => {
    const rt = runtime(true);
    const res = runDetailsCommand(rt, "   ");
    expect(res.error).toBe(true);
  });
});
