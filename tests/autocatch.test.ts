// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockState } from "../src/lock.js";
import { acquireUnderLock, makeLockState } from "../src/lock.js";
import { writeTier } from "../src/storage.js";
import type { DecisionRecord, TierPaths } from "../src/types.js";

// Mock callLlmWithTool to return canned extract/build results. resolveModel throws a
// ModelResolutionError-shaped Error when set to fail (mirrors the real llm.ts throw).
const MODEL_FAIL_MSG = "No model configured for user-decisions auto-catch";
const { callLlmWithToolMock, getResolveFail, setResolveFail } = vi.hoisted(() => {
  const m = vi.fn();
  let resolveFail = false;
  return {
    callLlmWithToolMock: m,
    getResolveFail: () => resolveFail,
    setResolveFail: (v: boolean) => {
      resolveFail = v;
    },
  };
});
const fakeModel = { id: "fake" } as unknown as Model<Api>;
const fakeRegistry = { getApiKeyAndHeaders: vi.fn() } as unknown as ModelRegistry;
vi.mock("../src/llm.js", () => ({
  callLlmWithTool: (...args: unknown[]) => callLlmWithToolMock(...args),
  resolveModel: () => {
    if (getResolveFail()) throw new Error(MODEL_FAIL_MSG);
    return { model: fakeModel, registry: fakeRegistry };
  },
  ModelResolutionError: class extends Error {},
}));

// : fake the retry backoff sleep so retry-loop tests don't wait real 1000ms/2000ms/… each.
// Mock ONLY `sleep` (keep PAUSED/PauseSignal/setPaused/readPauseState real via importActual).
const { sleepMock } = vi.hoisted(() => ({ sleepMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/pause-state.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, sleep: (...args: unknown[]) => sleepMock(...args) };
});

// Import AFTER mock registration.
import { type AutoCatchDeps, runCapture } from "../src/autocatch.js";
import { PauseSignal, readPauseState } from "../src/pause-state.js";
import { readTier } from "../src/storage.js";

let mockExtractResult: { action: "skip" | "add"; summary: string | null; detail: string | null } | null = null;
let mockBuildResult: {
  action: "insert" | "skip" | "supersede";
  beforePosition: number | null;
  supersedes: number[] | null;
} | null = null;

/** reportError mock — captured so tests can assert failure was reported (in-memory + notify). */
const reportErrorMock = vi.fn();

let dir: string;
let lockState: LockState;
let tp: TierPaths;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-autocatch-"));
  const active = path.join(dir, "s.jsonl");
  tp = { active, evicted: path.join(dir, "s.evicted.jsonl"), dropped: path.join(dir, "s.dropped.jsonl") };
  lockState = makeLockState();
  mockExtractResult = null;
  mockBuildResult = null;
  setResolveFail(RESOLVE_SUCCEEDS);
  callLlmWithToolMock.mockReset();
  reportErrorMock.mockReset();
  sleepMock.mockReset();
  sleepMock.mockResolvedValue(undefined); // : instant backoff (no real wait)
  // Default: extract → add, build → insert top
  callLlmWithToolMock.mockImplementation((opts) => {
    // distinguish extract vs build by tool name
    const tool = opts.tool as { name: string };
    const name = tool.name;
    if (name === "return_candidate") {
      return mockExtractResult ?? { action: "add", summary: "S", detail: "D" };
    }
    if (name === "return_build") {
      return mockBuildResult ?? { action: "insert", beforePosition: null, supersedes: null };
    }
    return null;
  });
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

function deps(): AutoCatchDeps {
  return {
    config: {
      captureMode: "background" as const,
      backgroundCaptureModel: null,
      rankingEnabled: true,
      injectIntoSystemPromptEnabled: true,
      limit: 20,
      backgroundRetries: 0, // no retries in most tests (callPhaseWithRetry still wraps; ui=null → skip on throw)
      backgroundThinkingLevel: "low" as const,
      backgroundMaxTokens: 8192,
      backgroundCallTimeoutMs: 30_000,
      backgroundCaptureDumpLimit: 30,
    },
    tiers: tp,
    lockState,
    lockFilePath: path.join(dir, "s.lock.sqlite"),
    retries: 0, //
    debugParentDir: null, // dumps disabled in unit tests
    ui: null, // headless → runCapture reports + skips on exhaustion (no dialog)
    mode: "tui",
    reportError: reportErrorMock, // central error reporting (in-memory + notify)
    onProgress: null, // not exercised by most tests
  };
}

/** Resolve fails (simulate failure) */
const RESOLVE_FAILS = true;

/** Resolve succeeds (simulate success) */
const RESOLVE_SUCCEEDS = false;

describe("runCapture — Phase 1 (extract)", () => {
  it("extract returns skip → nothing written, lock never acquired", async () => {
    mockExtractResult = { action: "skip", summary: null, detail: null };
    const result = await runCapture(deps(), "agent before", "user reply");
    expect(result).toBe(false);
    expect(lockState.held).toBe(false);
    expect(readTier(tp.active)).toHaveLength(0);
  });

  it("extract returns add but missing summary → false (no write)", async () => {
    mockExtractResult = { action: "add", summary: null, detail: "D" };
    expect(await runCapture(deps(), "a", "u")).toBe(false);
    expect(readTier(tp.active)).toHaveLength(0);
  });

  it("resolveModel THROWS (no model) → failure → reportError + skip (headless), lock never acquired", async () => {
    setResolveFail(RESOLVE_FAILS);
    expect(await runCapture(deps(), "a", "u")).toBe(false);
    expect(lockState.held).toBe(false);
    expect(reportErrorMock).toHaveBeenCalledTimes(1); // model-resolution failure is reported
    expect(reportErrorMock).toHaveBeenCalledWith(MODEL_FAIL_MSG);
  });
});

describe("runCapture — Phase 2 (build + write under lock)", () => {
  it("extract add + build insert (ranked, beforePosition=null) → record at top, lock released", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS)]);
    const result = await runCapture(deps(), "a", "u");
    expect(result).toBe(true);
    expect(readTier(tp.active).map((r) => r.id)).toEqual([3, 1, 2]); // new at top
    expect(lockState.held).toBe(false); // released in finally
  });

  it("writes an extract+build debug dump when debugParentDir is set", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    const debugDir = path.join(dir, "debug-root");
    const d = deps();
    d.debugParentDir = debugDir; // enable dumps
    const result = await runCapture(d, "agent before text", "user reply text");
    expect(result).toBe(true);
    const dumpDir = path.join(debugDir, "debug");
    const files = fs.readdirSync(dumpDir).filter((f) => f.startsWith("capture-"));
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(dumpDir, files[0] as string), "utf8");
    expect(content).toContain("=== EXTRACT INPUT ===");
    expect(content).toContain("--- SYSTEM PROMPT ---");
    expect(content).toContain("--- TOOL ---");
    expect(content).toContain("--- USER MESSAGE ---");
    expect(content).toContain("<agent-before>");
    expect(content).toContain("agent before text");
    expect(content).toContain("<user-reply>");
    expect(content).toContain("=== EXTRACT OUTPUT ===");
    expect(content).toContain("=== BUILD INPUT ===");
    expect(content).toContain("<candidate>");
    expect(content).toContain("<existing>");
    expect(content).toContain("=== BUILD OUTPUT ===");
    expect(content).toContain("action: insert");
  });

  it("writes a dump on the extract-SKIP path (failure-diagnosis case)", async () => {
    const debugDir = path.join(dir, "debug-skip");
    const d = deps();
    d.debugParentDir = debugDir; // enable dumps
    mockExtractResult = { action: "skip", summary: null, detail: null };
    const result = await runCapture(d, "agent before", "user reply");
    expect(result).toBe(false);
    const dumpDir = path.join(debugDir, "debug");
    const files = fs.readdirSync(dumpDir).filter((f) => f.startsWith("capture-"));
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(dumpDir, files[0] as string), "utf8");
    expect(content).toContain("=== EXTRACT INPUT ===");
    expect(content).toContain("=== EXTRACT OUTPUT ==="); // the skip decision is recorded
    expect(content).toContain('"action":"skip"'); // JSON of the skip result
    expect(content).not.toContain("=== BUILD INPUT ==="); // build never ran
    expect(content).not.toContain("=== BUILD OUTPUT ===");
  });

  it("writes a dump on the build-SKIP path (failure-diagnosis case)", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    const debugDir = path.join(dir, "debug-buildskip");
    const d = deps();
    d.debugParentDir = debugDir;
    mockBuildResult = { action: "skip", beforePosition: null, supersedes: null };
    const result = await runCapture(d, "agent before", "user reply");
    expect(result).toBe(false);
    const dumpDir = path.join(debugDir, "debug");
    const files = fs.readdirSync(dumpDir).filter((f) => f.startsWith("capture-"));
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(dumpDir, files[0] as string), "utf8");
    expect(content).toContain("=== EXTRACT INPUT ===");
    expect(content).toContain("=== EXTRACT OUTPUT ===");
    expect(content).toContain("action=add"); // extract produced a candidate
    expect(content).toContain("=== BUILD INPUT ===");
    expect(content).toContain("=== BUILD OUTPUT ==="); // the skip decision is recorded
    expect(content).toContain('"action":"skip"');
  });

  it("makeStreamingDump emits interleaved labeled blocks (Thinking/Message/ToolCalls)", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    const debugDir = path.join(dir, "debug-stream");
    const d = deps();
    d.debugParentDir = debugDir; // enable dumps → makeStreamingDump is wired
    // Feed interleaved deltas through onDebugDelta: thinking, then text, then toolcall,
    // then more text (a kind change back to text). Exercises buffering + kind-change flush.
    callLlmWithToolMock.mockImplementation((opts) => {
      const onDelta = (opts as { onDebugDelta: ((kind: string, text: string) => void) | null }).onDebugDelta;
      if (onDelta) {
        onDelta("thinking_delta", "reasoning part 1 ");
        onDelta("thinking_delta", "reasoning part 2");
        onDelta("text_delta", "visible message ");
        onDelta("toolcall_delta", '{"partial":');
        onDelta("text_delta", "more text after tool");
      }
      const tool = opts.tool as { name: string };
      if (tool.name === "return_candidate") return { action: "add", summary: "S", detail: "D" };
      return { action: "insert", beforePosition: null, supersedes: null };
    });
    const result = await runCapture(d, "agent before text", "user reply text");
    expect(result).toBe(true);
    const dumpDir = path.join(debugDir, "debug");
    const files = fs.readdirSync(dumpDir).filter((f) => f.startsWith("capture-"));
    const content = fs.readFileSync(path.join(dumpDir, files[0] as string), "utf8");
    // Each kind-change flushes the previous buffer under its label; the final block flushes on capture end.
    expect(content).toContain("Thinking: reasoning part 1 reasoning part 2\n");
    expect(content).toContain("Message: visible message \n");
    expect(content).toContain('ToolCalls: {"partial":\n');
    expect(content).toContain("Message: more text after tool\n");
  });

  it("build supersede:[1] → record 1 moved to dropped, new carries supersedes back-ref", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS)]);
    mockBuildResult = { action: "supersede", beforePosition: null, supersedes: [1] };
    const result = await runCapture(deps(), "a", "u");
    expect(result).toBe(true);
    expect(readTier(tp.active).map((r) => r.id)).toEqual([3, 2]); // 1 superseded
    expect(readTier(tp.dropped).map((r) => r.id)).toEqual([1]);
    expect(readTier(tp.active).find((r) => r.id === 3)?.supersedes).toEqual([1]);
    expect(lockState.held).toBe(false);
  });

  it("build returns skip → false, no write", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    mockBuildResult = { action: "skip", beforePosition: null, supersedes: null };
    expect(await runCapture(deps(), "a", "u")).toBe(false);
    expect(readTier(tp.active).map((r) => r.id)).toEqual([1]); // unchanged
    expect(lockState.held).toBe(false);
  });

  it("lock acquire failure → false after Phase 1 ran (no write)", async () => {
    // Under the SQLite mutex there is no plantable lock file; an un-acquirable
    // mutex only happens via a real cross-process holder or a bad path. Force the latter:
    // a path whose parent dir does not exist makes open fail → acquireUnderLock returns
    // null → runCapture treats it as a skip (Phase 1 may have run, nothing written).
    const bad = deps();
    bad.lockFilePath = path.join(dir, "no-such-dir-xyz", "s.lock.sqlite");
    const result = await runCapture(bad, "a", "u");
    expect(result).toBe(false);
    expect(readTier(tp.active)).toHaveLength(0);
    expect(lockState.held).toBe(false); // acquire failed — never held
  });

  it("Phase 2 throws → finally releases the lock; no write", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    // Force the BUILD callLlmWithTool to throw (simulate LLM failure mid-build)
    let buildCallCount = 0;
    callLlmWithToolMock.mockImplementation((opts) => {
      const name = (opts.tool as { name: string }).name;
      if (name === "return_candidate") return { action: "add", summary: "S", detail: "D" };
      buildCallCount++;
      throw new Error("build LLM exploded");
    });
    const result = await runCapture(deps(), "a", "u");
    expect(result).toBe(false);
    expect(buildCallCount).toBe(1);
    expect(lockState.held).toBe(false); // finally released
    expect(readTier(tp.active).map((r) => r.id)).toEqual([1]); // unchanged
  });

  it("mutual exclusion: a slow build holds the SQLite mutex — a concurrent acquire blocks until it finishes", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    // Build returns only after we resolve `releaseBuild`; while pending, the SQLite mutex is held.
    let releaseBuild: () => void = () => {};
    const buildPending = new Promise<{ action: "insert"; beforePosition: null; supersedes: null }>((resolve) => {
      releaseBuild = () => resolve({ action: "insert", beforePosition: null, supersedes: null });
    });
    callLlmWithToolMock.mockImplementation((opts) => {
      const name = (opts.tool as { name: string }).name;
      if (name === "return_candidate") return { action: "add", summary: "S", detail: "D" };
      return buildPending; // build hangs until released → mutex stays held
    });
    const capture = runCapture(deps(), "a", "u");
    // Let microtasks settle so Phase 2 acquires the mutex.
    await new Promise((r) => setTimeout(r, 20));
    // While the build holds the mutex, a second acquireUnderLock on the same lock DB blocks.
    const other = makeLockState();
    let otherRan = false;
    const otherLockDb = path.join(dir, "s.lock.sqlite");
    const otherP = acquireUnderLock(other, otherLockDb, async () => {
      otherRan = true;
      return "other";
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(otherRan).toBe(false); // still blocked — the build holds the mutex
    // Release the build; the other acquire now proceeds.
    releaseBuild();
    const result = await capture;
    expect(result).toBe(true);
    expect(lockState.held).toBe(false);
    const otherRes = await otherP;
    expect(otherRes).toBe("other");
  });
});

describe("runCapture — retry + pause (callWithRetry)", () => {
  it("extract throws then succeeds within retries → runCapture succeeds (retry works, errors propagate)", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    let extractCalls = 0;
    callLlmWithToolMock.mockImplementation((opts) => {
      const name = (opts.tool as { name: string }).name;
      if (name === "return_candidate") {
        extractCalls++;
        if (extractCalls < 3) throw new Error("transient"); // fail twice
        return { action: "add", summary: "S", detail: "D" }; // succeed on 3rd
      }
      return { action: "insert", beforePosition: null, supersedes: null };
    });
    const d = deps();
    d.retries = 3; // allow 3 retries
    const result = await runCapture(d, "a", "u");
    expect(result).toBe(true);
    expect(extractCalls).toBe(3); // retried
    expect(readTier(tp.active).map((r) => r.id)).toEqual([2, 1]);
    // : backoff fires between attempts with exponential delays (faked — no real wait).
    // attempt 0 fail → sleep(1000); attempt 1 fail → sleep(2000); attempt 2 succeeds (no sleep).
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenNthCalledWith(1, 1000);
    expect(sleepMock).toHaveBeenNthCalledWith(2, 2000);
    sleepMock.mockClear();
  });

  it("extract always throws, exhausted, headless (ui=null) → reportError + false (no dialog)", async () => {
    callLlmWithToolMock.mockImplementation((opts) => {
      if ((opts.tool as { name: string }).name === "return_candidate") throw new Error("permanent");
      return null;
    });
    const d = deps();
    d.retries = 1;
    d.ui = null; // headless → reportError + skip
    const result = await runCapture(d, "a", "u");
    expect(result).toBe(false);
    expect(callLlmWithToolMock).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(reportErrorMock).toHaveBeenCalledTimes(1); // failure reported even headless
  });

  it("R2-20a: long multiline error is sanitized → ≤200 chars + single line (reportError msg)", async () => {
    // A multi-line stack-trace-like message that exceeds the 200-char cap.
    const longMsg = `Line one with detail\nLine two continues\n${"x".repeat(250)}`;
    callLlmWithToolMock.mockImplementation(() => {
      throw new Error(longMsg);
    });
    const d = deps();
    d.retries = 0; // exhaust immediately
    d.ui = null; // headless → reportError + skip
    const result = await runCapture(d, "a", "u");
    expect(result).toBe(false);
    const reported = reportErrorMock.mock.calls[0]?.[0] as string;
    expect(reported.length).toBeLessThanOrEqual(200); // capped
    expect(reported).not.toMatch(/\r|\n/); // newlines stripped → single line
    expect(reported.startsWith("Line one with detail")).toBe(true);
  });

  it("exhaustion with ui → user picks Pause → throws PauseSignal (drain keeps queue)", async () => {
    callLlmWithToolMock.mockImplementation(() => {
      throw new Error("permanent");
    });
    const d = deps();
    d.retries = 0; // exhaust immediately
    d.ui = {
      notify: vi.fn(),
      select: vi.fn().mockResolvedValue("Pause auto-catch to investigate"),
    } as unknown as NonNullable<typeof d.ui>;
    await expect(runCapture(d, "a", "u")).rejects.toThrow(PauseSignal);
    // pause state persisted
    expect(readPauseState(tp.active).paused).toBe(true);
  });

  it("exhaustion with ui → user picks Continue → re-runs (capture retries until success)", async () => {
    let extractCalls = 0;
    callLlmWithToolMock.mockImplementation((opts) => {
      if ((opts.tool as { name: string }).name === "return_candidate") {
        extractCalls++;
        if (extractCalls < 3) throw new Error("transient");
        return { action: "add", summary: "S", detail: "D" };
      }
      return { action: "insert", beforePosition: null, supersedes: null };
    });
    const d = deps();
    d.retries = 0; // exhaust on first failure
    d.ui = {
      notify: vi.fn(),
      select: vi.fn().mockResolvedValue("Continue retrying"),
    } as unknown as NonNullable<typeof d.ui>;
    const result = await runCapture(d, "a", "u");
    expect(result).toBe(true); // continued, eventually succeeded
    expect(extractCalls).toBe(3);
  });

  it("Continue re-runs the WHOLE capture (extract+build) — extract re-runs after a build failure", async () => {
    // Build fails first round (exhausts → dialog → Continue); on re-run BOTH extract and build fire
    // again (the candidate is NOT held across the dialog). Proves whole-capture
    // rerun, not just the failing phase.
    let extractCalls = 0;
    let buildCalls = 0;
    callLlmWithToolMock.mockImplementation((opts) => {
      const name = (opts.tool as { name: string }).name;
      if (name === "return_candidate") {
        extractCalls++;
        return { action: "add", summary: "S", detail: "D" }; // extract always succeeds
      }
      if (name === "return_build") {
        buildCalls++;
        if (buildCalls === 1) throw new Error("build transient"); // build fails first time
        return { action: "insert", beforePosition: null, supersedes: null };
      }
      return null;
    });
    const d = deps();
    d.retries = 0;
    d.ui = {
      notify: vi.fn(),
      select: vi.fn().mockResolvedValueOnce("Continue retrying"),
    } as unknown as NonNullable<typeof d.ui>;
    const result = await runCapture(d, "a", "u");
    expect(result).toBe(true);
    expect(extractCalls).toBe(2); // extract re-ran on Continue (whole-capture rerun, not just build)
    expect(buildCalls).toBe(2);
  });

  it("exhaustion with ui → user DISMISSES (undefined) → PauseSignal + paused", async () => {
    callLlmWithToolMock.mockImplementation(() => {
      throw new Error("permanent");
    });
    const d = deps();
    d.retries = 0;
    d.ui = {
      notify: vi.fn(),
      select: vi.fn().mockResolvedValue(undefined), // dismissed (Esc) — same as explicit Pause per
    } as unknown as NonNullable<typeof d.ui>;
    await expect(runCapture(d, "a", "u")).rejects.toThrow(PauseSignal);
    expect(readPauseState(tp.active).paused).toBe(true);
  });

  it("abort mid-capture → retry loop terminates immediately (no extra attempts, no dialog)", async () => {
    // Real scenario: the drain sets lockState.abort to a controller BEFORE runCapture; mid-capture
    // quit calls cleanupOnExit which aborts that controller + nulls lockState.abort. callPhaseWithRetry
    // captured the signal at entry, so the catch sees signal.aborted → terminal (no retry/backoff/dialog).
    const controller = new AbortController();
    const d = deps();
    d.retries = 5; // would normally retry up to 5 times
    d.lockState.abort = controller; // set by the drain before runCapture
    let extractCalls = 0;
    callLlmWithToolMock.mockImplementation((opts) => {
      if ((opts.tool as { name: string }).name === "return_candidate") {
        extractCalls++;
        // simulate cleanupOnExit aborting + nulling DURING this attempt
        controller.abort();
        d.lockState.abort = null;
        throw new Error("fail");
      }
      return null;
    });
    const result = await runCapture(d, "a", "u");
    expect(result).toBe(false);
    // Exactly ONE attempt — the terminal-abort guard in the catch fired (no retries/backoff/dialog)
    expect(extractCalls).toBe(1);
  });
});

describe("runCapture — onProgress threading", () => {
  it("deps.onProgress is forwarded to callLlmWithTool", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    let receivedOnProgress: unknown = null;
    callLlmWithToolMock.mockImplementation((opts) => {
      receivedOnProgress = opts.onProgress;
      if ((opts.tool as { name: string }).name === "return_candidate")
        return { action: "add", summary: "S", detail: "D" };
      return { action: "insert", beforePosition: null, supersedes: null };
    });
    const seen: number[] = [];
    const d: AutoCatchDeps = { ...deps(), onProgress: (t: number) => seen.push(t) };
    await runCapture(d, "a", "u");
    expect(receivedOnProgress).toBeTypeOf("function"); // forwarded, not null
  });

  it("onProgress null (not wired) → no throw, capture still works", async () => {
    writeTier(tp.active, [rec(1, NO_DECISION_OPTS)]);
    const d = deps();
    d.onProgress = null;
    const result = await runCapture(d, "a", "u");
    expect(result).toBe(true);
  });
});
