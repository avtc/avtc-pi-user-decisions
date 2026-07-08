// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// Mock os.homedir so settings never reads the user's real ~/.pi/agent/settings.json.
const mockOs = vi.hoisted(() => ({ homeDir: "" as string }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockOs.homeDir };
});

import decisionsExtension from "../src/index.js";
import { DECISIONS_SCHEMA } from "../src/schema.js";
import { _resetGetDecisionsSettings, _setGetDecisionsSettings } from "../src/settings-ui.js";
import type { DecisionsConfig } from "../src/types.js";

/** Schema-derived defaults — the base config each test starts from. */
function baseDecisionsConfig(): DecisionsConfig {
  const d = {} as Record<string, unknown>;
  for (const s of DECISIONS_SCHEMA.settings) d[s.id] = s.defaultValue;
  return d as unknown as DecisionsConfig;
}

/** The globalThis key used by the reload-safe wiring guard. */
const WIRED_KEY = "__avtcPiUserDecisionsWired";

interface SpyPi {
  pi: ExtensionAPI;
  on: MockInstance;
  registerCommand: MockInstance;
  registerTool: MockInstance;
  appendEntry: MockInstance;
}

/**
 * Minimal pi mock whose `pi.events` is undefined (so the vendored ui-bridge / dialog-coordinator
 * snippets no-op) and whose `on` / `registerTool` / `registerCommand` / `appendEntry` are spies —
 * letting the idempotency tests assert whether a call actually wired anything.
 */
function createSpyPi(): SpyPi {
  const on = vi.fn();
  const registerCommand = vi.fn();
  const registerTool = vi.fn();
  const appendEntry = vi.fn();
  const pi = {
    on,
    registerCommand,
    registerTool,
    appendEntry,
    // undefined → vendored snippets return early (graceful no-op for incomplete test mocks).
    events: undefined,
  } as unknown as ExtensionAPI;
  return { pi, on, registerCommand, registerTool, appendEntry };
}

function mockCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] } as unknown as ExtensionContext["sessionManager"],
    model: undefined,
    modelRegistry: null,
  } as unknown as ExtensionContext;
}

let savedCwd: string;
let dir: string;

beforeEach(() => {
  savedCwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-idem-"));
  mockOs.homeDir = path.join(dir, "home");
  process.chdir(dir);
  // Each test starts from an unwired state — the guard short-circuits otherwise.
  delete (globalThis as Record<string, unknown>)[WIRED_KEY];
  delete (globalThis as Record<string, unknown>).__piUserDecisions;
  _setGetDecisionsSettings(() => baseDecisionsConfig());
});

afterEach(() => {
  process.chdir(savedCwd);
  _resetGetDecisionsSettings();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("decisionsExtension — reload-safe globalThis wiring guard", () => {
  it("(a) first call wires (registers handlers + commands)", () => {
    const { pi, on, registerCommand } = createSpyPi();
    decisionsExtension(pi);

    // session_start + the other lifecycle hooks are registered via pi.on.
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
    // the pause/resume/list/details commands are registered via pi.registerCommand.
    expect(registerCommand).toHaveBeenCalled();
  });

  it("(c) after first call the globalThis wired flag is set to true", () => {
    const { pi } = createSpyPi();
    decisionsExtension(pi);

    expect((globalThis as Record<string, unknown>)[WIRED_KEY]).toBe(true);
  });

  it("(b) second call (flag still set) no-ops — registers nothing on a new pi", () => {
    const first = createSpyPi();
    decisionsExtension(first.pi); // wires + sets the flag

    const second = createSpyPi();
    decisionsExtension(second.pi); // flag set → early return → NOTHING wired on `second`

    expect(second.on).not.toHaveBeenCalled();
    expect(second.registerCommand).not.toHaveBeenCalled();
    expect(second.registerTool).not.toHaveBeenCalled();
    expect(second.appendEntry).not.toHaveBeenCalled();
  });

  it("(d) reload-safe cycle: session_shutdown resets the flag → a fresh call re-wires", async () => {
    const first = createSpyPi();
    decisionsExtension(first.pi); // wires + sets flag
    expect((globalThis as Record<string, unknown>)[WIRED_KEY]).toBe(true);

    // Simulate /reload: pi fires session_shutdown with reason "reload", and the guard's
    // session_shutdown handler must reset the flag so the next activate re-wires.
    const shutdownHandlers = first.on.mock.calls
      .filter(([event]) => event === "session_shutdown")
      .map(([, handler]) => handler as (...a: unknown[]) => unknown);
    expect(shutdownHandlers.length).toBeGreaterThan(0);
    for (const handler of shutdownHandlers) {
      await handler({ reason: "reload" }, mockCtx(dir));
    }
    expect((globalThis as Record<string, unknown>)[WIRED_KEY]).toBe(false);

    // After reload the module is re-evaluated fresh; a new activate must wire again (not dead).
    const reloaded = createSpyPi();
    decisionsExtension(reloaded.pi);
    expect(reloaded.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect((globalThis as Record<string, unknown>)[WIRED_KEY]).toBe(true);
  });
});
