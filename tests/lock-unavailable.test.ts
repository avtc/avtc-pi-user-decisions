// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// R2-20b — the user_decision_add lock-unavailable path (`result === null` → "decisions store busy").
// Same-process SQLite contention can't be triggered deterministically (BEGIN IMMEDIATE is exclusive
// and acquireUnderLock's blocking retry waits for the holder), so we mock the lock module to force
// acquireUnderLock → null and assert the handler surfaces the error result (not a throw, not a hang).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockState } from "../src/lock.js";
import type { ToolRuntime } from "../src/tools.js";
import type { TierPaths } from "../src/types.js";

// Mock the lock module so acquireUnderLock resolves null (simulates a contended/busy store).
vi.mock("../src/lock.js", () => ({
  makeLockState: () => ({ lockDbPath: null, mutex: null, held: false, abort: null }),
  acquireUnderLock: vi.fn(async () => null), // contended → caller surfaces error
  cleanupOnExit: () => {},
}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-lockbusy-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("user_decision_add — lock unavailable (R2-20b)", () => {
  it("acquireUnderLock returns null → isError result 'decisions store busy'", async () => {
    const { registerDecisionTools } = await import("../src/tools.js");
    const tools: {
      name: string;
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    }[] = [];
    const pi = {
      registerTool(t: (typeof tools)[number]) {
        tools.push(t);
      },
    } as unknown as ExtensionAPI;

    const rt = {
      config: {
        captureMode: "agent",
        backgroundCaptureModel: null,
        rankingEnabled: true,
        injectIntoSystemPromptEnabled: true,
        limit: 20,
        backgroundRetries: 0,
        backgroundThinkingLevel: "low" as const,
        backgroundMaxTokens: 8192,
        backgroundCallTimeoutMs: 30_000,
        backgroundCaptureDumpLimit: 30,
      },
      tiers: {
        active: path.join(dir, "s1.jsonl"),
        evicted: path.join(dir, "s1.evicted.jsonl"),
        dropped: path.join(dir, "s1.dropped.jsonl"),
      } as TierPaths,
      lockState: { lockDbPath: null, mutex: null, held: false, abort: null } as LockState,
      lockFilePath: path.join(dir, "s1.lock.sqlite"),
    };
    registerDecisionTools(pi, () => rt as ToolRuntime, { allowAdd: true });

    const add = tools.find((t) => t.name === "user_decision_add");
    const result = (await add?.execute("id", { summary: "new" })) as {
      content: { text: string }[];
      details: { error: string };
    };
    expect(result.details.error).toContain("decisions store busy");
    expect(result.content[0].text).toContain("decisions store busy");
  });
});
