// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock runCapture so hook-integration tests can assert the hooks call it with the right
// args + gates, without running the real LLM pipeline (that's covered by autocatch.test.ts).
const { runCaptureMock } = vi.hoisted(() => ({ runCaptureMock: vi.fn() }));
vi.mock("../src/autocatch.js", () => ({
  runCapture: (...args: unknown[]) => runCaptureMock(...args),
}));

// Mock os.homedir so loadConfig never reads the user's real ~/.pi/agent/settings.json.
// The mock homeDir is set in beforeEach to a temp directory with no settings file,
// isolating tests from the user's global config (prevents captureMode leaks).
const mockOs = vi.hoisted(() => ({ homeDir: "" as string }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockOs.homeDir };
});

import decisionsExtension from "../src/index.js";
import { PAUSED, readPauseState, setPaused } from "../src/pause-state.js";
import { DECISIONS_SCHEMA } from "../src/schema.js";
import { _resetGetDecisionsSettings, _setGetDecisionsSettings } from "../src/settings-ui.js";
import { serializeRecord } from "../src/storage.js";
import type { DecisionRecord, DecisionsConfig } from "../src/types.js";

// --- test settings (mock pattern: drive getDecisionsSettings directly, no file/env ceremony) ---

/** Schema-derived defaults — the base config each test starts from. */
function baseDecisionsConfig(): DecisionsConfig {
  const d = {} as Record<string, unknown>;
  for (const s of DECISIONS_SCHEMA.settings) d[s.id] = s.defaultValue;
  return d as unknown as DecisionsConfig;
}

/** Mutable live config read by getDecisionsSettings via the mock override. */
let testConfig: DecisionsConfig = baseDecisionsConfig();

// --- mock pi ---
interface RegisteredTool {
  name: string;
}
interface RegisteredCommand {
  name: string;
  handler: (args?: string) => unknown;
  description: string;
}
interface Handlers {
  session_start?: (event: unknown, ctx: ExtensionContext) => unknown;
  session_compact?: (event: unknown, ctx: ExtensionContext) => unknown;
  before_agent_start?: (event: { prompt?: string; systemPrompt?: string }, ctx: ExtensionContext) => unknown;
  session_shutdown?: (event: unknown, ctx: ExtensionContext) => unknown;
  tool_result?: (event: unknown, ctx: ExtensionContext) => unknown;
  input?: (event: { source?: string; text?: string; streamingBehavior?: string }, ctx: ExtensionContext) => unknown;
  message_end?: (event: { message: { role: string } }, ctx: ExtensionContext) => unknown;
}

function createMockPi() {
  const handlerList: Map<string, Array<(e: unknown, ctx: ExtensionContext) => unknown>> = new Map();
  const registered: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  // Fork-state propagation: capture appendEntry calls so tests can assert CustomEntry appends.
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const pi = {
    on(event: string, handler: (e: unknown, ctx: ExtensionContext) => unknown) {
      const list = handlerList.get(event) ?? [];
      list.push(handler);
      handlerList.set(event, list);
    },
    registerTool(t: { name: string }) {
      registered.push({ name: t.name });
    },
    registerCommand(name: string, def: { description: string; handler: () => unknown }) {
      commands.push({ name, description: def.description, handler: def.handler });
    },
    appendEntry<T = unknown>(customType: string, data?: T) {
      appendedEntries.push({ customType, data });
    },
  };
  // Dynamic proxy: wraps all handlers for each event, calling them all and returning the last non-void result.
  const handlers = new Proxy({} as Handlers, {
    get(_target, prop) {
      const key = String(prop);
      const list = handlerList.get(key);
      if (!list) return undefined;
      return async (e: unknown, ctx: ExtensionContext) => {
        let lastResult: unknown;
        for (const fn of list) {
          const r = await fn(e, ctx);
          if (r !== undefined) lastResult = r;
        }
        return lastResult;
      };
    },
  });
  return { pi: pi as unknown as ExtensionAPI, handlers, registered, commands, appendedEntries };
}

/** Like createMockPi, but `appendEntry` THROWS — for degradation tests (persist-side failure:
 *  the cache must still be injected; the session must not crash). */
function createMockPiThrowingAppend() {
  const base = createMockPi();
  const throwingPi = {
    ...base.pi,
    appendEntry: () => {
      throw new Error("disk full (simulated)");
    },
  };
  return { ...base, pi: throwingPi as unknown as ExtensionAPI };
}

function mockCtx(cwd: string, sessionId: string): ExtensionContext {
  return mockCtxBranch(cwd, sessionId, []);
}

/** Like mockCtx, but seeds the session branch (for fork-state restore tests). */
function mockCtxBranch(cwd: string, sessionId: string, branch: unknown[]): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
    } as unknown as ExtensionContext["sessionManager"],
    model: undefined,
    modelRegistry: null,
  } as unknown as ExtensionContext;
}

/** Like mockCtx, but `sessionManager.getBranch` THROWS — for restore-side degradation tests
 *  (environmental getBranch failure: the child must fall back to the file read, not crash). */
function mockCtxThrowingGetBranch(cwd: string, sessionId: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => {
        throw new Error("corrupt session (simulated I/O)");
      },
    } as unknown as ExtensionContext["sessionManager"],
    model: undefined,
    modelRegistry: null,
  } as unknown as ExtensionContext;
}

/** Build a ctx whose `ui` spies on setStatus/notify (exercise the status-bar wiring). */
function ctxWithUi(
  cwd: string,
  sessionId: string,
  ui: {
    setStatus: (key: string, text: string) => void;
    notify: (msg: string, level: string) => void;
  },
): ExtensionContext {
  return { ...mockCtx(cwd, sessionId), ui } as unknown as ExtensionContext;
}

/** ctx whose getBranch returns one assistant message (the agentBefore context for auto-catch hooks). */
function ctxWithAssistant(cwd: string, sessionId: string, text: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() },
          id: "a1",
          parentId: null,
          timestamp: new Date().toISOString(),
        },
      ],
    } as unknown as ExtensionContext["sessionManager"],
    model: undefined,
    modelRegistry: null,
  } as unknown as ExtensionContext;
}

/** ctx whose getBranch returns a user message followed by an assistant message. */
function ctxWithUserAndAssistant(
  cwd: string,
  sessionId: string,
  userText: string,
  assistantText: string,
): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
          id: "u1",
          parentId: null,
          timestamp: new Date().toISOString(),
        },
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: assistantText }], timestamp: Date.now() },
          id: "a1",
          parentId: null,
          timestamp: new Date().toISOString(),
        },
      ],
    } as unknown as ExtensionContext["sessionManager"],
    model: undefined,
    modelRegistry: null,
  } as unknown as ExtensionContext;
}

function rec(id: number, opts: Partial<DecisionRecord>): DecisionRecord {
  return {
    id,
    scope: "session",
    supersedes: null,
    timestamp: new Date().toISOString(),
    summary: `decision ${id}`,
    detail: `detail ${id}`,
    ...opts,
  };
}

/** Trigger a steer capture: input(streamingBehavior=steer) + message_end(role=assistant). */
async function triggerSteerCapture(handlers: Handlers, ctx: ExtensionContext, userText: string): Promise<void> {
  await handlers.input?.({ streamingBehavior: "steer", text: userText }, ctx);
  await handlers.message_end?.({ message: { role: "assistant" } }, ctx);
}

/**
 * Reset the extension's globalThis-scoped state. Used in beforeEach AND at intra-test points that
 * simulate an independent activation (a child process / a fresh session): the reload-safe wiring
 * guard flag plus the runtime state both live on globalThis, which persists across calls in the
 * same process. Call before a `decisionsExtension(pi)` that must fully wire.
 */
function resetGlobalExtensionState(): void {
  delete (globalThis as Record<string, unknown>).__piUserDecisions;
  delete (globalThis as { __avtcPiUserDecisionsWired?: boolean }).__avtcPiUserDecisionsWired;
}

// --- env / cwd save-restore ---
let savedCwd: string;
let savedParentPid: string | undefined;
let savedSessionFile: string | undefined;
let savedExtraTools: string | undefined;
let dir: string;

beforeEach(() => {
  savedCwd = process.cwd();
  savedParentPid = process.env.PI_SUBAGENT_PARENT_PID;
  savedSessionFile = process.env.PI_DECISIONS_SESSION_FILE;
  savedExtraTools = process.env.PI_SUBAGENT_TOOLS_ADD;
  delete process.env.PI_SUBAGENT_PARENT_PID;
  delete process.env.PI_DECISIONS_SESSION_FILE;
  delete process.env.PI_SUBAGENT_TOOLS_ADD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-ext-"));
  // Isolate from the user's real home (defensive — other code may call os.homedir).
  mockOs.homeDir = path.join(dir, "home");
  process.chdir(dir);
  runCaptureMock.mockReset();
  runCaptureMock.mockResolvedValue(false); // default: capture finds nothing
  // Reset the extension's globalThis state (survives across tests in the same process): runtime
  // state + the reload-safe wiring-guard flag (else the first test short-circuits all the rest).
  resetGlobalExtensionState();
  // Drive settings via the mock: each test starts from schema defaults, mutated by writeSettings.
  testConfig = baseDecisionsConfig();
  _setGetDecisionsSettings(() => testConfig);
});
afterEach(() => {
  process.chdir(savedCwd);
  if (savedParentPid === undefined) delete process.env.PI_SUBAGENT_PARENT_PID;
  else process.env.PI_SUBAGENT_PARENT_PID = savedParentPid;
  if (savedSessionFile === undefined) delete process.env.PI_DECISIONS_SESSION_FILE;
  else process.env.PI_DECISIONS_SESSION_FILE = savedSessionFile;
  if (savedExtraTools === undefined) delete process.env.PI_SUBAGENT_TOOLS_ADD;
  else process.env.PI_SUBAGENT_TOOLS_ADD = savedExtraTools;
  _resetGetDecisionsSettings();
  fs.rmSync(dir, { recursive: true, force: true });
});

function sessionsPath(): string {
  return path.join(dir, ".pi", "user-decisions", "sessions");
}

function sessionFile(): string {
  return path.join(sessionsPath(), "s1.jsonl");
}

describe("decisionsExtension factory — bootstrap", () => {
  it("creates sessions/ dir at load", () => {
    const { pi } = createMockPi();
    decisionsExtension(pi);
    expect(fs.existsSync(sessionsPath())).toBe(true);
  });
});

describe("session_start (root, mode=agent default) — tools + env var", () => {
  it("registers 3 agent tools (add+list+detail) and sets PI_DECISIONS_SESSION_FILE to the session path", async () => {
    const { pi, handlers, registered } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    expect(registered.map((t) => t.name).sort()).toEqual([
      "user_decision_add",
      "user_decision_detail",
      "user_decision_list",
    ]);
    expect(process.env.PI_DECISIONS_SESSION_FILE).toBe(sessionFile());
  });

  it("mode=background → registers list+detail ONLY (read-only; pipeline owns writes, no user_decision_add)", async () => {
    writeModeSettings("background");
    const { pi, handlers, registered } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    expect(registered.map((t) => t.name).sort()).toEqual(["user_decision_detail", "user_decision_list"]);
    expect(registered.map((t) => t.name)).not.toContain("user_decision_add");
  });
});

describe("before_agent_start — inject cache", () => {
  it("empty store → returns undefined (section omitted)", async () => {
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    const result = await handlers.before_agent_start?.({ systemPrompt: "base" }, mockCtx(dir, "s1"));
    expect(result).toBeUndefined();
  });

  it("undefined systemPrompt + store has record → cache appended to empty string (R2-20c)", async () => {
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "Use jsonl" }))}\n`);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    const result = (await handlers.before_agent_start?.({ systemPrompt: undefined }, mockCtx(dir, "s1"))) as {
      systemPrompt: string;
    };
    // `?? ""` guard: no TypeError on undefined; cache becomes the whole prompt.
    expect(result.systemPrompt.startsWith("## User Decisions (this session)")).toBe(true);
  });

  it("store has a record → returns { systemPrompt: base + cache } with header + record", async () => {
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "Use jsonl" }))}\n`);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    const result = (await handlers.before_agent_start?.({ systemPrompt: "BASE" }, mockCtx(dir, "s1"))) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt).toContain("BASE");
    expect(result.systemPrompt).toContain("## User Decisions (this session)");
    expect(result.systemPrompt).toContain("- 1 Use jsonl");
  });
});

describe("session_compact — rebuilds cache", () => {
  it("writes record AFTER start, then session_compact → next before_agent_start includes it", async () => {
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    let result: { systemPrompt: string } | undefined;
    result = (await handlers.before_agent_start?.({ systemPrompt: "BASE" }, mockCtx(dir, "s1"))) as
      | {
          systemPrompt: string;
        }
      | undefined;
    expect(result).toBeUndefined();
    // write a record (simulating a tool add that wrote to disk)
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(7, { summary: "decided 7" }))}\n`);
    // session_compact rebuilds the cache
    await handlers.session_compact?.({}, mockCtx(dir, "s1"));
    result = (await handlers.before_agent_start?.({ systemPrompt: "BASE" }, mockCtx(dir, "s1"))) as {
      systemPrompt: string;
    };
    if (!result) throw new Error("expected result");
    expect(result.systemPrompt).toContain("- 7 decided 7");
  });
});

describe("config gating — captureMode:none (kill switch, replaces enabled:false)", () => {
  it("session_start builds no runtime; before_agent_start returns undefined; nothing registered", async () => {
    const { pi, handlers, registered } = createMockPi();
    writeSettings({ captureMode: "none" });
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    expect(registered).toHaveLength(0);
    const result = await handlers.before_agent_start?.({ systemPrompt: "BASE" }, mockCtx(dir, "s1"));
    expect(result).toBeUndefined();
  });
});

describe("injectIntoSystemPromptEnabled:false", () => {
  it("builds runtime (tools registered, store usable) but cache stays null; no injection; session_compact skips", async () => {
    const { pi, handlers, registered, appendedEntries } = createMockPi();
    writeSettings({ injectIntoSystemPromptEnabled: false });
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    // tools still registered (capture/storage/tools work)
    expect(registered.length).toBe(3);
    // write a record
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "x" }))}\n`);
    // before_agent_start does NOT inject (cache null)
    const result = await handlers.before_agent_start?.({ systemPrompt: "BASE" }, mockCtx(dir, "s1"));
    expect(result).toBeUndefined();
    // session_compact skips refresh (injection disabled) → no snapshot appended.
    const beforeCompact = appendedEntries.length;
    await handlers.session_compact?.({}, mockCtx(dir, "s1"));
    expect(appendedEntries.length).toBe(beforeCompact); // compact enabled-gate prevented the append
    const result2 = await handlers.before_agent_start?.({ systemPrompt: "BASE" }, mockCtx(dir, "s1"));
    expect(result2).toBeUndefined();
  });
});

describe("root-vs-subagent gate", () => {
  it("subagent uses PI_DECISIONS_SESSION_FILE, does NOT overwrite it", async () => {
    process.env.PI_SUBAGENT_PARENT_PID = "12345";
    const subPath = path.join(dir, "other.jsonl");
    process.env.PI_DECISIONS_SESSION_FILE = subPath;
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "child-session-id"));
    // subagent keeps the inherited path verbatim
    expect(process.env.PI_DECISIONS_SESSION_FILE).toBe(subPath);
  });

  it("subagent WITHOUT env var → degraded (no runtime, no tools, no injection)", async () => {
    process.env.PI_SUBAGENT_PARENT_PID = "12345";
    // no PI_DECISIONS_SESSION_FILE
    const { pi, handlers, registered } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "child-session-id"));
    expect(registered).toHaveLength(0);
    const result = await handlers.before_agent_start?.({ systemPrompt: "BASE" }, mockCtx(dir, "child-session-id"));
    expect(result).toBeUndefined();
  });
});

function writeSettings(settings: Record<string, unknown>): void {
  // Mutate the live mock config (read by getDecisionsSettings). Partial — unspecified keys keep
  // their schema defaults.
  Object.assign(testConfig as unknown as Record<string, unknown>, settings);
}

function writeModeSettings(mode: "agent" | "background" | "none"): void {
  writeSettings({ captureMode: mode });
}

describe("contributor wiring (Phase 7.2)", () => {
  it("root session_start with mode=agent → PI_SUBAGENT_TOOLS_ADD contains add+list+detail", async () => {
    writeModeSettings("agent");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    const tools = (process.env.PI_SUBAGENT_TOOLS_ADD ?? "").split(",");
    expect(tools).toEqual(expect.arrayContaining(["user_decision_add", "user_decision_list", "user_decision_detail"]));
  });

  it("root session_start with mode=background → contributes list+detail ONLY (read-only; no user_decision_add)", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    // background mode is read-only for the agent: the pipeline owns all writes → no user_decision_add contributed
    const tools = (process.env.PI_SUBAGENT_TOOLS_ADD ?? "").split(",").filter((t) => t.length > 0);
    expect(tools).toEqual(expect.arrayContaining(["user_decision_list", "user_decision_detail"]));
    expect(tools).not.toContain("user_decision_add");
  });

  it("subagent (PI_SUBAGENT_PARENT_PID set) → contributor NOT called (env var unset)", async () => {
    writeModeSettings("agent");
    process.env.PI_SUBAGENT_PARENT_PID = "12345";
    process.env.PI_DECISIONS_SESSION_FILE = path.join(dir, "shared.jsonl");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "child-session-id"));
    // subagent inherits TOOLS_ADD via cascade; it must NOT re-contribute (redundant)
    expect(process.env.PI_SUBAGENT_TOOLS_ADD).toBeUndefined();
  });

  it("preserves an existing TOOLS_ADD value (append-with-dedup, commutative with other contributors)", async () => {
    writeModeSettings("agent");
    process.env.PI_SUBAGENT_TOOLS_ADD = "todo_init,todo_add";
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    const tools = (process.env.PI_SUBAGENT_TOOLS_ADD ?? "").split(",");
    expect(tools).toEqual(["todo_init", "todo_add", "user_decision_add", "user_decision_list", "user_decision_detail"]);
  });
});

describe("subagent before_agent_start — injects from inherited session path", () => {
  it("subagent reads the shared session file and injects it on its first turn", async () => {
    process.env.PI_SUBAGENT_PARENT_PID = "12345";
    // a shared session file with one record (written by the parent / a sibling)
    const shared = path.join(dir, "shared.jsonl");
    fs.writeFileSync(shared, `${serializeRecord(rec(9, { summary: "shared decision" }))}\n`);
    process.env.PI_DECISIONS_SESSION_FILE = shared;
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    // subagent builds its own runtime from the env path at session_start
    await handlers.session_start?.({}, mockCtx(dir, "child-session-id"));
    // ...and injects the shared decisions on before_agent_start (first turn)
    const result = (await handlers.before_agent_start?.(
      { systemPrompt: "CHILD" },
      mockCtx(dir, "child-session-id"),
    )) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt).toContain("CHILD");
    expect(result.systemPrompt).toContain("9 shared decision");
  });
});

describe("teardown — safe when no lock was ever acquired", () => {
  it("session_shutdown handler does not throw when no tool ever took the lock", async () => {
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    // No tool call → lock never acquired (state.held=false, lockPath set but file absent).
    // session_shutdown must be a safe no-op, not throw.
    expect(() => handlers.session_shutdown?.({}, mockCtx(dir, "s1"))).not.toThrow();
  });
});

describe("auto-catch hooks — tool_result + input", () => {
  it("tool_result: non-cancelled aUQ answer → runCapture called with agentBefore + Q→A reply", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "Should we use jsonl?"));
    // answers map keys ARE the question text (avtc-pi-ask-user-question ResultSchema)
    await handlers.tool_result?.(
      { type: "tool_result", toolName: "ask_user_question", details: { answers: { "Should we use jsonl?": "Yes" } } },
      ctxWithAssistant(dir, "s1", "Should we use jsonl?"),
    );
    // : poll for the async drain instead of a fixed setTimeout(0) (racy under load).
    await vi.waitFor(() => {
      expect(runCaptureMock).toHaveBeenCalledTimes(1);
    });
    const [deps, agentBefore, userReply] = runCaptureMock.mock.calls[0] as unknown[] as [
      {
        retries: number;
        debugParentDir: string;
        onProgress: ((t: number) => void) | null;
        reportError: (m: string) => void;
      },
      string,
      string,
    ];
    expect(agentBefore).toBe("Should we use jsonl?\n\nQ1: Should we use jsonl?");
    expect(userReply).toBe("Answer to Q1: Yes");
    // : assert the constructed deps are wired (not ignored): retries from config default,
    // debugParentDir = dataDir(cwd), onProgress + reportError are real callbacks.
    expect(deps.retries).toBe(3); // schema default (test settings set mode only)
    expect(deps.debugParentDir).toBe(path.join(dir, ".pi", "user-decisions")); // dataDir(cwd)
    expect(typeof deps.onProgress).toBe("function"); //  token sink wired
    expect(typeof deps.reportError).toBe("function"); //  error sink wired
  });

  it("tool_result: cancelled aUQ → runCapture NOT called", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "Should we use jsonl?"));
    await handlers.tool_result?.(
      { type: "tool_result", toolName: "ask_user_question", details: { cancelled: true } },
      ctxWithAssistant(dir, "s1", "Should we use jsonl?"),
    );
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(runCaptureMock).not.toHaveBeenCalled();
  });

  it("tool_result: aUQ with no preceding agent text → question used as agentBefore", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    // Branch with no assistant text — agent asked aUQ as a tool-only turn.
    const ctxNoAgent = {
      cwd: dir,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
            id: "u1",
            parentId: null,
            timestamp: new Date().toISOString(),
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "ask_user_question",
              content: [{ type: "text", text: "yes" }],
              timestamp: Date.now(),
            },
            id: "t1",
            parentId: null,
            timestamp: new Date().toISOString(),
          },
        ],
      } as unknown as ExtensionContext["sessionManager"],
      model: undefined,
      modelRegistry: null,
    } as unknown as ExtensionContext;
    await handlers.session_start?.({}, ctxNoAgent);
    await handlers.tool_result?.(
      { type: "tool_result", toolName: "ask_user_question", details: { answers: { "Commit all?": "Yes" } } },
      ctxNoAgent,
    );
    await vi.waitFor(() => {
      expect(runCaptureMock).toHaveBeenCalledTimes(1);
    });
    const [, agentBefore, userReply] = runCaptureMock.mock.calls[0] as unknown[] as [unknown, string, string];
    // agentBefore should be the question text since there's no preceding agent message
    expect(agentBefore).toBe("Q1: Commit all?");
    expect(userReply).toBe("Answer to Q1: Yes");
  });

  it("tool_result: two consecutive aUQ calls share the same preceding agent text", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    // Branch with an assistant message, but no agent text on branch at tool_result time
    // (simulating the real timing where the agent's message isn't added until after tool completes).
    const ctxNoAgent = {
      cwd: dir,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
            id: "u1",
            parentId: null,
            timestamp: new Date().toISOString(),
          },
        ],
      } as unknown as ExtensionContext["sessionManager"],
      model: undefined,
      modelRegistry: null,
    } as unknown as ExtensionContext;
    await handlers.session_start?.({}, ctxNoAgent);
    // First aUQ — agentText is null (no assistant on branch), so question is used as agentBefore.
    await handlers.tool_result?.(
      { type: "tool_result", toolName: "ask_user_question", details: { answers: { "Q one?": "Yes" } } },
      ctxNoAgent,
    );
    // Second aUQ — agentText is still null (cached from first call), so question is used.
    await handlers.tool_result?.(
      { type: "tool_result", toolName: "ask_user_question", details: { answers: { "Q two?": "No" } } },
      ctxNoAgent,
    );
    await vi.waitFor(() => {
      expect(runCaptureMock).toHaveBeenCalledTimes(2);
    });
    const [, agentBefore1] = runCaptureMock.mock.calls[0] as unknown[] as [unknown, string, string];
    const [, agentBefore2] = runCaptureMock.mock.calls[1] as unknown[] as [unknown, string, string];
    // Both should have just the question since there's no preceding agent text
    expect(agentBefore1).toBe("Q1: Q one?");
    expect(agentBefore2).toBe("Q1: Q two?");
  });

  it("tool_result: non-aUQ tool (e.g. read) → NOT called", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "Should we use jsonl?"));
    await handlers.tool_result?.(
      { type: "tool_result", toolName: "read", details: undefined },
      ctxWithAssistant(dir, "s1", "Should we use jsonl?"),
    );
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(runCaptureMock).not.toHaveBeenCalled();
  });

  it("input: source interactive → runCapture called with agentBefore + text", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "Should we use jsonl?"));
    await triggerSteerCapture(
      handlers,
      ctxWithUserAndAssistant(dir, "s1", "Let's switch to postgres", "Should we use jsonl?"),
      "Let's switch to postgres",
    );
    // : poll for the async drain instead of a fixed setTimeout(0).
    await vi.waitFor(() => {
      expect(runCaptureMock).toHaveBeenCalledTimes(1);
    });
    const [deps, agentBefore, userReply] = runCaptureMock.mock.calls[0] as unknown[] as [
      {
        retries: number;
        debugParentDir: string;
        onProgress: ((t: number) => void) | null;
        reportError: (m: string) => void;
      },
      string,
      string,
    ];
    expect(agentBefore).toBe("Should we use jsonl?");
    expect(userReply).toBe("Let's switch to postgres");
    // : deps wired (not ignored) — same invariants as the aUQ path.
    expect(deps.retries).toBe(3);
    expect(deps.debugParentDir).toBe(path.join(dir, ".pi", "user-decisions"));
    expect(typeof deps.onProgress).toBe("function");
    expect(typeof deps.reportError).toBe("function");
  });

  it("input: aUQ tool_result on branch → NOT called (skipped, handled by tool_result)", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "Should we use jsonl?"));
    // Branch has a toolResult for ask_user_question as first entry → isFirstEntryAskUserQuestion returns true.
    const ctxAuq = {
      cwd: dir,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "ask_user_question",
              content: [{ type: "text", text: "yes" }],
              timestamp: Date.now(),
            },
            id: "t1",
            parentId: null,
            timestamp: new Date().toISOString(),
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Should we use jsonl?" }],
              timestamp: Date.now(),
            },
            id: "a1",
            parentId: null,
            timestamp: new Date().toISOString(),
          },
        ],
      } as unknown as ExtensionContext["sessionManager"],
      model: undefined,
      modelRegistry: null,
    } as unknown as ExtensionContext;
    await handlers.input?.({}, ctxAuq);
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(runCaptureMock).not.toHaveBeenCalled();
  });

  it("mode gate: mode='manual' → before_agent_start does NOT launch capture", async () => {
    writeModeSettings("agent");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "Should we use jsonl?"));
    await triggerSteerCapture(
      handlers,
      ctxWithUserAndAssistant(dir, "s1", "a decision", "Should we use jsonl?"),
      "a decision",
    );
    expect(runCaptureMock).not.toHaveBeenCalled();
  });

  it("mode gate : tool_result bails BEFORE work in manual mode (hoisted gate)", async () => {
    writeModeSettings("agent");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "context"));
    // A non-cancelled aUQ answer that WOULD trigger capture in auto mode → nothing in manual.
    await handlers.tool_result?.(
      {
        type: "tool_result",
        toolName: "ask_user_question",
        details: { cancelled: false, answers: { "use jsonl?": "yes" } },
      },
      ctxWithAssistant(dir, "s1", "context"),
    );
    expect(runCaptureMock).not.toHaveBeenCalled();
  });

  it("queue : a second before_agent_start while one capture is running is QUEUED, not dropped — both run", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "context"));
    // First capture resolves only after `releaseFirst` is called → the drain is busy with it.
    let releaseFirst: () => void = () => {};
    const firstPending = new Promise<boolean>((resolve) => {
      releaseFirst = () => resolve(false);
    });
    runCaptureMock.mockReturnValueOnce(firstPending);
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "first", "context"), "first");
    // Second input arrives while the first capture is still in flight — it must QUEUE, not drop.
    runCaptureMock.mockResolvedValueOnce(false);
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "second", "context"), "second");
    // Only the first has STARTED so far (sequential drain — one in flight).
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    expect((runCaptureMock.mock.calls[0] as unknown[])[2]).toBe("first");
    // Release the first → the drain proceeds to the queued second.
    releaseFirst();
    // : poll for the second capture to finish instead of a fixed setTimeout(5).
    await vi.waitFor(() => {
      expect(runCaptureMock).toHaveBeenCalledTimes(2); // both processed — no data loss
    });
    expect((runCaptureMock.mock.calls[1] as unknown[])[2]).toBe("second");
  });

  it("session_shutdown reason=reload → queue preserved; reason=quit → queue cleared + in-flight aborted", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "context"));
    // A capture that hangs until we resolve it → the drain stays busy and subsequent inputs QUEUE.
    let releaseFirst: () => void = () => {};
    runCaptureMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseFirst = () => resolve(false);
      }),
    );
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "first", "context"), "first");
    // : poll for the first capture to start instead of a fixed setTimeout(5).
    await vi.waitFor(() => {
      expect(runCaptureMock).toHaveBeenCalledTimes(1); // only the in-flight first
    });
    // A second input queues while the first is in flight.
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "second", "context"), "second");
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    expect(runCaptureMock).toHaveBeenCalledTimes(1); // only the in-flight first
    // quit → queue cleared + in-flight aborted via cleanupOnExit (abort fires). Release the
    // first so its drain iteration ends; the queued "second" must NOT run (queue was cleared).
    await handlers.session_shutdown?.({ reason: "quit" }, mockCtx(dir, "s1"));
    releaseFirst();
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    expect(runCaptureMock).toHaveBeenCalledTimes(1); // "second" never ran — queue was cleared by quit
    // reload path does NOT clear the queue (globalThis survives).
    runCaptureMock.mockResolvedValue(false);
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "third", "context"), "third");
    await handlers.session_shutdown?.({ reason: "reload" }, mockCtx(dir, "s1"));
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    // reload keeps the queue; the in-flight capture was not stolen. The drain continues after
    // 'first' resolves and processes the enqueued 'third' (reload did NOT clear the queue).
    // : poll for 'third' to be processed instead of a fixed setTimeout(10).
    await vi.waitFor(() => {
      expect(runCaptureMock).toHaveBeenCalledTimes(2); // 'first' then 'third' (reload preserved the queue)
    });
  });

  it("drain honors persisted pause — runCapture NOT called while paused; resume flushes", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "context"));
    // Write a pause-state file sibling to the active jsonl → readPauseState.paused === true.
    const active = path.join(dir, ".pi", "user-decisions", "sessions", "s1.jsonl");
    fs.writeFileSync(active.replace(/\.jsonl$/, ".state.json"), JSON.stringify({ paused: true }));
    runCaptureMock.mockResolvedValue(false);
    // Enqueue while paused → the drain must SKIP (re-enqueue at front, stop).
    await triggerSteerCapture(
      handlers,
      ctxWithUserAndAssistant(dir, "s1", "paused-capture", "context"),
      "paused-capture",
    );
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(runCaptureMock).not.toHaveBeenCalled(); // paused → drain skipped
    // Clear pause (simulate /user-decisions:resume) → drain re-kicked → capture runs.
    fs.writeFileSync(active.replace(/\.jsonl$/, ".state.json"), JSON.stringify({ paused: false }));
    const resume = handlers.session_start; // resume re-triggers via the resume command; here just re-enqueue+drain
    void resume;
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "after-resume", "context"), "after-resume");
    // : poll for the resumed capture to run instead of a fixed setTimeout(10).
    await vi.waitFor(() => {
      expect(runCaptureMock).toHaveBeenCalled(); // resumed → drain processed
    });
  });

  it("ui.setStatus is called during capture + cleared on session_shutdown", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    const setStatus = vi.fn();
    const notify = vi.fn();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithUi(dir, "s1", { setStatus, notify }));
    runCaptureMock.mockReturnValue(
      new Promise<boolean>(() => {}), // hang so streaming stays true
    );
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "hi", "ctx"), "hi");
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    // setStatus called during capture (the in-processing/status render)
    expect(setStatus).toHaveBeenCalled();
    const lastCall = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[1] ?? "";
    expect(lastCall).toContain("Q&A:");
    // shutdown clears the status bar
    await handlers.session_shutdown?.({ reason: "reload" }, ctxWithUi(dir, "s1", { setStatus, notify }));
    const finalCall = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[1] ?? "NOT_EMPTY";
    expect(finalCall).toBe(""); // STATUS_CLEAR
  });

  it("while streaming, refreshStatus reuses the cached TotalActive (no recount)", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    const setStatus = vi.fn();
    const notify = vi.fn();
    // Seed 1 decision BEFORE session_start so session_start's refresh warms the cache with count=1.
    const sessionsDir = path.join(dir, ".pi", "user-decisions", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const active = path.join(sessionsDir, "s1.jsonl");
    fs.writeFileSync(
      active,
      `${serializeRecord({
        id: 1,
        scope: "session",
        supersedes: null,
        timestamp: new Date().toISOString(),
        summary: "seed",
        detail: "d",
      })}\n`,
    );
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithUi(dir, "s1", { setStatus, notify }));
    // Start a capture that hangs → streaming stays true; refreshStatus at enqueue uses the cache.
    runCaptureMock.mockReturnValue(new Promise<boolean>(() => {}));
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "hi", "ctx"), "hi");
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    // While streaming, append a SECOND decision directly to the file.
    fs.appendFileSync(
      active,
      `${serializeRecord({
        id: 2,
        scope: "session",
        supersedes: null,
        timestamp: new Date().toISOString(),
        summary: "hidden",
        detail: "d",
      })}\n`,
    );
    const qaCalls = setStatus.mock.calls.map((c) => c[1] as string).filter((t) => t.includes("Q&A:"));
    // The streaming-time Q&A status must show the CACHED count (1), NOT the freshly-appended count (2),
    // proving refreshStatus skipped the re-read while streaming.
    expect(qaCalls[qaCalls.length - 1]).toContain("Q&A:1");
    expect(qaCalls[qaCalls.length - 1]).not.toContain("Q&A:2");
    // Clean shutdown so the hung capture's lock is released.
    await handlers.session_shutdown?.({ reason: "quit" }, ctxWithUi(dir, "s1", { setStatus, notify }));
  });

  it("session_shutdown new/resume/fork → queue cleared (like quit)", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithAssistant(dir, "s1", "context"));
    let release: () => void = () => {};
    runCaptureMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = () => resolve(false);
      }),
    );
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "first", "context"), "first");
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "second", "context"), "second");
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    expect(runCaptureMock).toHaveBeenCalledTimes(1); // first in flight
    for (const reason of ["new", "resume", "fork"] as const) {
      await handlers.session_shutdown?.({ reason }, mockCtx(dir, "s1"));
      release();
      await new Promise((r) => {
        setTimeout(r, 5);
      });
      // queue cleared by each of these reasons; re-enqueue for the next iteration of the loop
      runCaptureMock.mockReturnValue(
        new Promise<boolean>((resolve) => {
          release = () => resolve(false);
        }),
      );
      const afterText = `after-${reason}`;
      await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", afterText, "context"), afterText);
    }
    // No throw across new/resume/fork; each cleared the queue ("second" never ran).
    // : poll for all 4 captures instead of relying on the loop's setTimeout(5) windows.
    await vi.waitFor(() => {
      expect(runCaptureMock).toHaveBeenCalledTimes(4); // first + 3 re-enqueued post-shutdown items
    });
  });

  it("drain generic-throw → ui.notify + continues to the next queue item", async () => {
    writeModeSettings("background");
    const { pi, handlers } = createMockPi();
    const setStatus = vi.fn();
    const notify = vi.fn();
    decisionsExtension(pi);
    await handlers.session_start?.({}, ctxWithUi(dir, "s1", { setStatus, notify }));
    // First capture throws; second succeeds.
    runCaptureMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(false);
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "throws", "context"), "throws");
    await triggerSteerCapture(handlers, ctxWithUserAndAssistant(dir, "s1", "ok", "context"), "ok");
    // : poll for both captures to finish instead of a fixed setTimeout(15).
    await vi.waitFor(() => {
      expect(runCaptureMock).toHaveBeenCalledTimes(2); // both processed (drain continued past the throw)
    });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("capture failed"), "error");
  });
});

describe("commands — pause/resume", () => {
  it("all commands registered at extension load (pause/resume + list/detail browse)", () => {
    const { pi, commands } = createMockPi();
    decisionsExtension(pi);
    const names = commands.map((c) => c.name);
    expect(names).toEqual([
      "user-decisions:settings",
      "user-decisions:pause",
      "user-decisions:resume",
      "user-decisions:list",
      "user-decisions:details",
    ]);
    expect(names).not.toContain("user-decisions:status"); // removed — duplicated the status bar
  });

  it("list/detail descriptions match approved text (Text Review)", () => {
    const { pi, commands } = createMockPi();
    decisionsExtension(pi);
    const list = commands.find((c) => c.name === "user-decisions:list");
    const detail = commands.find((c) => c.name === "user-decisions:details");
    expect(list?.description).toBe("List user decisions (optionally filtered by a substring)");
    expect(detail?.description).toBe("Show a user decision's full details by id");
  });

  it("list command (root) → notifies with the live decisions (filtered by substring)", async () => {
    writeModeSettings("agent");
    const { pi, handlers, commands } = createMockPi();
    decisionsExtension(pi);
    const notified = vi.fn();
    const ui = { setStatus: () => {}, notify: notified };
    await handlers.session_start?.({}, ctxWithUi(dir, "s1", ui)); // session_start captures ctx.ui into state.ui
    // seed two decisions directly into the session active file
    const rec = (id: number, summary: string): string =>
      serializeRecord({
        id,
        scope: "session",
        supersedes: null,
        timestamp: "2026-06-23T00:00:00.000Z",
        summary,
        detail: "",
      });
    fs.appendFileSync(sessionFile(), `${rec(1, "Use SQLite")}\n${rec(2, "Use Redis")}\n`);
    const list = commands.find((c) => c.name === "user-decisions:list");
    await list?.handler("sqlite");
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0][0]).toContain("1 Use SQLite");
    expect(notified.mock.calls[0][0]).not.toContain("Redis");
    expect(notified.mock.calls[0][1]).toBe("info");
  });

  it("detail command (root) → notifies with the full record", async () => {
    writeModeSettings("agent");
    const { pi, handlers, commands } = createMockPi();
    decisionsExtension(pi);
    const notified = vi.fn();
    await handlers.session_start?.({}, ctxWithUi(dir, "s1", { setStatus: () => {}, notify: notified }));
    fs.appendFileSync(
      sessionFile(),
      `${serializeRecord({ id: 7, scope: "session", supersedes: null, timestamp: "2026-06-23T00:00:00.000Z", summary: "alpha", detail: "the rationale" })}\n`,
    );
    const detail = commands.find((c) => c.name === "user-decisions:details");
    await detail?.handler("7");
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0][0]).toContain("7 alpha");
    expect(notified.mock.calls[0][0]).toContain("the rationale");
  });

  it("detail command missing id → notifies error", async () => {
    writeModeSettings("agent");
    const { pi, handlers, commands } = createMockPi();
    decisionsExtension(pi);
    const notified = vi.fn();
    await handlers.session_start?.({}, ctxWithUi(dir, "s1", { setStatus: () => {}, notify: notified }));
    const detail = commands.find((c) => c.name === "user-decisions:details");
    await detail?.handler("999");
    expect(notified.mock.calls[0][1]).toBe("error");
  });

  it("pause/resume descriptions match approved text (Text Review)", () => {
    const { pi, commands } = createMockPi();
    decisionsExtension(pi);
    const pause = commands.find((c) => c.name === "user-decisions:pause");
    const resume = commands.find((c) => c.name === "user-decisions:resume");
    // <!-- approved -->
    expect(pause?.description).toBe("Pause auto-processing of captured user decisions");
    expect(resume?.description).toBe("Resume auto-processing of captured user decisions");
  });

  it("pause command (root) → pause state persisted", async () => {
    writeModeSettings("background");
    const { pi, handlers, commands } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    const pause = commands.find((c) => c.name === "user-decisions:pause");
    await pause?.handler();
    // pause state written next to the session's active jsonl
    const active = path.join(dir, ".pi", "user-decisions", "sessions", "s1.jsonl");
    expect(readPauseState(active).paused).toBe(true);
  });

  it("resume command (root) → pause state cleared", async () => {
    writeModeSettings("background");
    const { pi, handlers, commands } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "s1"));
    const active = path.join(dir, ".pi", "user-decisions", "sessions", "s1.jsonl");
    setPaused(active, PAUSED, process.pid); // pre-paused
    expect(readPauseState(active).paused).toBe(true);
    const resume = commands.find((c) => c.name === "user-decisions:resume");
    await resume?.handler();
    expect(readPauseState(active).paused).toBe(false);
  });

  it("subagent (PI_SUBAGENT_PARENT_PID set) → commands no-op (root-only gate)", async () => {
    writeModeSettings("background");
    process.env.PI_SUBAGENT_PARENT_PID = "12345";
    const { pi, handlers, commands } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({}, mockCtx(dir, "child"));
    const active = path.join(dir, ".pi", "user-decisions", "sessions", "child.jsonl");
    const pause = commands.find((c) => c.name === "user-decisions:pause");
    await pause?.handler();
    // no pause state written — subagent command is a no-op (root-only)
    expect(readPauseState(active).paused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fork-state cache propagation — CustomEntry handoff to
// forked subagent children so the child injects the parent's frozen snapshot.
// ---------------------------------------------------------------------------

describe("fork-state cache propagation — session_start append/restore", () => {
  it("parent startup (empty branch) → appends ONE 'user-decisions-cache' with the rendered cache", async () => {
    const { pi, handlers, appendedEntries } = createMockPi();
    decisionsExtension(pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "Use jsonl" }))}\n`);
    await handlers.session_start?.({ reason: "startup" }, mockCtx(dir, "s1"));
    expect(appendedEntries).toHaveLength(1);
    expect(appendedEntries[0].customType).toBe("user-decisions-cache");
    const data = appendedEntries[0].data as { content?: string };
    expect(typeof data.content).toBe("string");
    expect(data.content).toContain("Use jsonl"); // rendered cache includes the record
  });

  it("child startup (branch seeded with parent snapshot) → restores, does NOT append again, injects snapshot", async () => {
    // Parent first: capture what it would append.
    const parent = createMockPi();
    decisionsExtension(parent.pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "Use jsonl" }))}\n`);
    await parent.handlers.session_start?.({ reason: "startup" }, mockCtx(dir, "s1"));
    const parentSnapshot = parent.appendedEntries[0];
    expect(parentSnapshot).toBeDefined();

    // Child: a branched session whose branch contains the parent's CustomEntry.
    const child = createMockPi();
    // Simulate a fresh child process: globalThis (runtime state + wiring flag) is cold, so the
    // child's decisionsExtension call fully wires and its session_start starts from a clean state.
    resetGlobalExtensionState();
    decisionsExtension(child.pi);
    const seededBranch = [{ type: "custom", customType: "user-decisions-cache", data: parentSnapshot.data }];
    await child.handlers.session_start?.({ reason: "startup" }, mockCtxBranch(dir, "s1", seededBranch));
    expect(child.appendedEntries).toHaveLength(0); // restored → no append

    // before_agent_start injects the snapshot content (frozen), not a fresh file read.
    const injected = (await child.handlers.before_agent_start?.(
      { systemPrompt: "base" },
      mockCtxBranch(dir, "s1", seededBranch),
    )) as { systemPrompt: string } | undefined;
    expect(injected?.systemPrompt).toContain("Use jsonl");
  });

  it("startup with seeded snapshot injects the snapshot, NOT the current file (prefix-cache alignment)", async () => {
    // Seed the branch with a snapshot value that differs from the file's current content.
    const snapshotContent = "## User Decisions (this session)\n- SNAPSHOT-VALUE-FROM-PARENT";
    const seededBranch = [{ type: "custom", customType: "user-decisions-cache", data: { content: snapshotContent } }];
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    // The on-disk file has DIFFERENT content (what the child would read fresh if it ignored the snapshot).
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "FRESH-FILE-VALUE" }))}\n`);
    await handlers.session_start?.({ reason: "startup" }, mockCtxBranch(dir, "s1", seededBranch));
    const injected = (await handlers.before_agent_start?.(
      { systemPrompt: "base" },
      mockCtxBranch(dir, "s1", seededBranch),
    )) as { systemPrompt: string } | undefined;
    expect(injected?.systemPrompt).toContain("SNAPSHOT-VALUE-FROM-PARENT");
    expect(injected?.systemPrompt).not.toContain("FRESH-FILE-VALUE");
  });

  it("cache is frozen: a file write after session_start does NOT change what before_agent_start injects", async () => {
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "original" }))}\n`);
    await handlers.session_start?.({ reason: "startup" }, mockCtx(dir, "s1"));
    // Simulate a decision being added (file write) — mirrors what user_decision_add does.
    fs.writeFileSync(
      sessionFile(),
      `${serializeRecord(rec(1, { summary: "original" }))}${serializeRecord(rec(2, { summary: "ADDED-LATER" }))}`,
    );
    const injected = (await handlers.before_agent_start?.({ systemPrompt: "base" }, mockCtx(dir, "s1"))) as
      | { systemPrompt: string }
      | undefined;
    // Frozen: only the original record is injected; the newly-written record is not (until next refresh).
    expect(injected?.systemPrompt).toContain("original");
    expect(injected?.systemPrompt).not.toContain("ADDED-LATER");
  });
});

describe("fork-state cache propagation — append rule per session_start reason", () => {
  // Seed a branch so restore COULD happen on startup/fork; we assert whether it appends per reason.
  const seededBranch = () => [
    { type: "custom", customType: "user-decisions-cache", data: { content: "- frozen snapshot" } },
  ];

  it("reason 'new'/'reload'/'resume' → reads fresh from file + appends (does not restore)", async () => {
    for (const reason of ["new", "reload", "resume"] as const) {
      // Each reason is an independent activation (fresh session) — reset globalThis so the
      // wiring guard + runtime state are cold for this iteration's decisionsExtension call.
      resetGlobalExtensionState();
      const { pi, handlers, appendedEntries } = createMockPi();
      decisionsExtension(pi);
      fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "fresh" }))}\n`);
      await handlers.session_start?.({ reason }, mockCtxBranch(dir, "s1", seededBranch()));
      expect(appendedEntries).toHaveLength(1); // fresh read → append
      const injected = (await handlers.before_agent_start?.(
        { systemPrompt: "base" },
        mockCtxBranch(dir, "s1", seededBranch()),
      )) as { systemPrompt: string } | undefined;
      // Did NOT restore → injected the file content, not the snapshot.
      expect(injected?.systemPrompt).toContain("fresh");
      expect(injected?.systemPrompt).not.toContain("frozen snapshot");
    }
  });

  it("reason 'fork' → does NOT append, but DOES restore/reuse the snapshot for injection", async () => {
    const { pi, handlers, appendedEntries } = createMockPi();
    decisionsExtension(pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "fresh" }))}\n`);
    const branch = seededBranch();
    await handlers.session_start?.({ reason: "fork" }, mockCtxBranch(dir, "s1", branch));
    expect(appendedEntries).toHaveLength(0); // : fork never appends
    // : fork restore is design-mandated for decisions ('restore (decisions)'), so
    // injection reflects the snapshot, not the fresh file read (buildRuntime clobbered rt.cache).
    const injected = (await handlers.before_agent_start?.(
      { systemPrompt: "base" },
      mockCtxBranch(dir, "s1", branch),
    )) as { systemPrompt: string } | undefined;
    expect(injected?.systemPrompt).toContain("frozen snapshot");
    expect(injected?.systemPrompt).not.toContain("fresh");
  });

  it("session_compact → appends the freshly-rendered cache : content + post-compact injection", async () => {
    const { pi, handlers, appendedEntries } = createMockPi();
    decisionsExtension(pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "fresh" }))}\n`);
    await handlers.session_start?.({ reason: "startup" }, mockCtx(dir, "s1"));
    const afterStart = appendedEntries.length;
    await handlers.session_compact?.({}, mockCtx(dir, "s1"));
    expect(appendedEntries.length).toBe(afterStart + 1); // compact always appends
    const appended = appendedEntries[appendedEntries.length - 1];
    expect(appended.customType).toBe("user-decisions-cache");
    expect((appended.data as { content?: string }).content).toContain("fresh"); // appended CONTENT
    // Post-compact before_agent_start injects the refreshed cache (content match).
    const injected = (await handlers.before_agent_start?.({ systemPrompt: "base" }, mockCtx(dir, "s1"))) as
      | { systemPrompt?: string }
      | undefined;
    expect(injected?.systemPrompt).toContain("fresh");
  });

  it("multiple session_compact refreshes each append; child restore returns the LATEST", async () => {
    // : multiple refreshes → each appends; restore (reverse-walk) returns the latest.
    const { pi, handlers, appendedEntries } = createMockPi();
    decisionsExtension(pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "v1" }))}\n`);
    await handlers.session_start?.({ reason: "startup" }, mockCtx(dir, "s1"));
    const afterStart = appendedEntries.length;
    // Mutate the file between compacts so each renderInjection differs (newline-separated JSONL).
    fs.writeFileSync(
      sessionFile(),
      `${serializeRecord(rec(1, { summary: "v1" }))}\n${serializeRecord(rec(2, { summary: "v2" }))}\n`,
    );
    await handlers.session_compact?.({}, mockCtx(dir, "s1"));
    fs.writeFileSync(
      sessionFile(),
      `${serializeRecord(rec(1, { summary: "v1" }))}\n${serializeRecord(rec(2, { summary: "v2" }))}\n${serializeRecord(rec(3, { summary: "v3" }))}\n`,
    );
    await handlers.session_compact?.({}, mockCtx(dir, "s1"));
    expect(appendedEntries.length).toBe(afterStart + 2); // TWO compacts → TWO new appends
    // The last appended snapshot is the latest render (contains v3, the newest record).
    const latest = appendedEntries[appendedEntries.length - 1] as { customType: string; data: { content: string } };
    expect(latest.data.content).toContain("v3");
    // A child restoring from this multi-entry branch gets the LATEST (reverse-walk).
    const child = createMockPi();
    // Fresh child process: cold globalThis (runtime state + wiring flag) so the child fully wires.
    resetGlobalExtensionState();
    decisionsExtension(child.pi);
    const seededBranch = appendedEntries
      .filter((e) => e.customType === "user-decisions-cache")
      .map((e) => ({ type: "custom", customType: "user-decisions-cache", data: e.data }));
    await child.handlers.session_start?.({ reason: "startup" }, mockCtxBranch(dir, "s1", seededBranch));
    const injected = (await child.handlers.before_agent_start?.(
      { systemPrompt: "base" },
      mockCtxBranch(dir, "s1", seededBranch),
    )) as { systemPrompt?: string } | undefined;
    expect(injected?.systemPrompt).toContain("v3"); // latest snapshot, not v1/v2
  });
});

// ---------------------------------------------------------------------------
// Failure-model + edge-case coverage (degradation).
// ---------------------------------------------------------------------------

describe("fork-state — failure model + edge cases", () => {
  it("a throwing appendEntry does NOT crash session_start and the cache is still injected (degrade)", async () => {
    // Persist-side environmental failure: appendEntry throws (disk full). The session must survive
    // and before_agent_start must still inject the (in-memory) cache — the load-bearing guarantee.
    const { pi, handlers } = createMockPiThrowingAppend();
    decisionsExtension(pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "persist me" }))}\n`);
    await expect(handlers.session_start?.({ reason: "startup" }, mockCtx(dir, "s1"))).resolves.not.toThrow();
    const injected = (await handlers.before_agent_start?.({ systemPrompt: "base" }, mockCtx(dir, "s1"))) as
      | { systemPrompt?: string }
      | undefined;
    expect(injected?.systemPrompt).toContain("persist me"); // cache survived in memory
  });

  it("a throwing getBranch (restore side) does NOT crash session_start and injects the FILE-read fallback", async () => {
    // Restore-side environmental failure (2): getBranch throws → restoreCacheSnapshot
    // degrades to undefined → handler falls back to the buildRuntime file read. The session must
    // survive and before_agent_start must still inject (the FILE content, not the unreachable snapshot).
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "file-fallback" }))}\n`);
    // getBranch throws → restore can't reach the snapshot → falls back to the file read.
    await expect(
      handlers.session_start?.({ reason: "startup" }, mockCtxThrowingGetBranch(dir, "s1")),
    ).resolves.not.toThrow();
    const injected = (await handlers.before_agent_start?.(
      { systemPrompt: "base" },
      mockCtxThrowingGetBranch(dir, "s1"),
    )) as { systemPrompt?: string } | undefined;
    expect(injected?.systemPrompt).toContain("file-fallback"); // file-read fallback, not the snapshot
    expect(injected?.systemPrompt).not.toContain("SNAPSHOT-ONLY");
  });

  it("child startup restores the snapshot even when injection is disabled (before_agent_start then bails)", async () => {
    // injectIntoSystemPromptEnabled:false → buildRuntime sets rt.cache = null; restore still runs and
    // would populate rt.cache from the snapshot, but before_agent_start bails on !enabled (returns undefined).
    writeSettings({ injectIntoSystemPromptEnabled: false });
    const snapshotContent = "## User Decisions (this session)\n- DISABLED-CASE-SNAPSHOT";
    const seededBranch = [{ type: "custom", customType: "user-decisions-cache", data: { content: snapshotContent } }];
    const { pi, handlers } = createMockPi();
    decisionsExtension(pi);
    await handlers.session_start?.({ reason: "startup" }, mockCtxBranch(dir, "s1", seededBranch));
    // Injection disabled → before_agent_start returns undefined regardless of the restored cache.
    const injected = await handlers.before_agent_start?.(
      { systemPrompt: "base" },
      mockCtxBranch(dir, "s1", seededBranch),
    );
    expect(injected).toBeUndefined();
  });

  it("empty store → session_start startup appends NOTHING (null cache early-return)", async () => {
    // No decision records → rt.cache is null → persistCacheSnapshot early-returns (no append).
    const { pi, handlers, appendedEntries } = createMockPi();
    decisionsExtension(pi);
    // (no sessionFile write → empty store)
    await handlers.session_start?.({ reason: "startup" }, mockCtx(dir, "s1"));
    expect(appendedEntries.filter((e) => e.customType === "user-decisions-cache")).toHaveLength(0);
  });

  it("fork with no snapshot in branch → no append, injects the file-read content", async () => {
    // fork always sets restored=true (never appends); with no snapshot, restore returns undefined and
    // rt.cache keeps the buildRuntime file-read value.
    const { pi, handlers, appendedEntries } = createMockPi();
    decisionsExtension(pi);
    fs.writeFileSync(sessionFile(), `${serializeRecord(rec(1, { summary: "file-value" }))}\n`);
    await handlers.session_start?.({ reason: "fork" }, mockCtxBranch(dir, "s1", []));
    expect(appendedEntries.filter((e) => e.customType === "user-decisions-cache")).toHaveLength(0);
    const injected = (await handlers.before_agent_start?.({ systemPrompt: "base" }, mockCtxBranch(dir, "s1", []))) as
      | { systemPrompt?: string }
      | undefined;
    expect(injected?.systemPrompt).toContain("file-value");
  });
});
