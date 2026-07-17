// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock agentLoop to a fake async-iterable that calls the tool's execute then resolves.
const agentLoopMock = vi.fn();
vi.mock("@earendil-works/pi-agent-core", () => ({
  agentLoop: (...args: unknown[]) => agentLoopMock(...args),
}));

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
// Import AFTER mock is registered.
import {
  type CallLlmOptions,
  callLlmWithTool,
  ModelResolutionError,
  resetCapturedModel,
  resolveModel,
  setCapturedModel,
} from "../src/llm.js";

/** No abort signal (don't abort) */
const NO_ABORT_SIGNAL: AbortSignal | null = null;
/** Test defaults for new LLM params */
const TEST_TIMEOUT_MS = 30_000;
const TEST_THINKING_LEVEL = "low" as const;
const TEST_MAX_TOKENS = 8192;

/** No registry options (use defaults) */
const NO_REGISTRY_OPTS: Partial<RegistryLike> | null = null;

/** Build callLlmWithTool options from the fields that vary across tests, filling the shared test
 *  defaults (timeout/thinking/maxTokens/registry/model). Keeps each test focused on what it varies
 *  now that the helper takes one options object. */
function optsFor<T>(overrides: {
  systemPrompt: string;
  userText: string;
  tool: AgentTool;
  model: Model<Api>;
  extract: () => T | undefined;
  onProgress?: ((tokens: number, words: number) => void) | null;
  thinkingLevel?: ModelThinkingLevel;
  timeoutMs?: number;
  registry?: ModelRegistry;
}): CallLlmOptions<T> {
  return {
    systemPrompt: overrides.systemPrompt,
    userText: overrides.userText,
    tool: overrides.tool,
    registry: overrides.registry ?? mockRegistry(NO_REGISTRY_OPTS),
    model: overrides.model,
    extract: overrides.extract,
    signal: NO_ABORT_SIGNAL,
    onProgress: overrides.onProgress ?? null,
    timeoutMs: overrides.timeoutMs ?? TEST_TIMEOUT_MS,
    thinkingLevel: overrides.thinkingLevel ?? TEST_THINKING_LEVEL,
    onDebugDelta: null,
    maxTokens: TEST_MAX_TOKENS,
  };
}

/** No model override string */
const NO_MODEL_OVERRIDE: string | null = null;

interface RegistryLike {
  find: (provider: string, modelId: string) => Model<Api> | undefined;
  getApiKeyAndHeaders: (
    model: Model<Api>,
  ) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
}

function mockRegistry(opts: Partial<RegistryLike> | null): ModelRegistry {
  return {
    find: opts?.find ?? (() => undefined),
    getApiKeyAndHeaders:
      opts?.getApiKeyAndHeaders ?? vi.fn().mockResolvedValue({ ok: true, apiKey: "key", headers: {} }),
  } as unknown as ModelRegistry;
}

function fakeModel(id: string): Model<Api> {
  return { id } as unknown as Model<Api>;
}

/** Build a fake agentLoop stream that calls the tool's execute, then resolves result. */
function makeFakeStream(tool: AgentTool, capturedRef: { called: boolean }) {
  const events: { type: string }[] = [{ type: "agent_start" }, { type: "agent_end" }];
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    async result() {
      // call the tool's execute to simulate the model invoking it
      if (!capturedRef.called) {
        capturedRef.called = true;
        await tool.execute("call-1", { action: "add", summary: "s", detail: "d" });
      }
      return [];
    },
  };
  return stream;
}

beforeEach(() => {
  agentLoopMock.mockReset();
  resetCapturedModel();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveModel", () => {
  it("override 'provider/id' resolved via registry.find", () => {
    const m = fakeModel("x");
    const reg = mockRegistry({ find: () => m });
    setCapturedModel(undefined, reg); // holder holds the registry for the override path
    const out = resolveModel("provider/id");
    expect(out?.model).toBe(m);
    expect(out?.registry).toBe(reg);
  });

  it("override with no slash → throws ModelResolutionError", () => {
    setCapturedModel(undefined, mockRegistry(NO_REGISTRY_OPTS));
    expect(() => resolveModel("noslash")).toThrow(ModelResolutionError);
  });

  it("override not found in registry → throws ModelResolutionError", () => {
    setCapturedModel(undefined, mockRegistry({ find: () => undefined }));
    expect(() => resolveModel("provider/missing")).toThrow(ModelResolutionError);
  });

  it("no override → uses captured session model", () => {
    const m = fakeModel("sess");
    setCapturedModel(m, mockRegistry(NO_REGISTRY_OPTS));
    const out = resolveModel(NO_MODEL_OVERRIDE);
    expect(out?.model).toBe(m);
  });

  it("no override and no session model → throws ModelResolutionError", () => {
    setCapturedModel(undefined, mockRegistry(NO_REGISTRY_OPTS));
    expect(() => resolveModel(NO_MODEL_OVERRIDE)).toThrow(ModelResolutionError);
  });

  it("no registry → throws ModelResolutionError", () => {
    setCapturedModel(fakeModel("m"), undefined);
    expect(() => resolveModel(NO_MODEL_OVERRIDE)).toThrow(ModelResolutionError);
  });
});

describe("callLlmWithTool", () => {
  it("returns the captured extraction value after draining the stream", async () => {
    const model = fakeModel("m");
    let captured: string | undefined;
    const tool = {
      name: "return_x",
      execute: async () => {
        captured = "VALUE";
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    } as unknown as AgentTool;
    agentLoopMock.mockImplementation(() => makeFakeStream(tool, { called: false }));
    const result = await callLlmWithTool(
      optsFor({
        systemPrompt: "SYS",
        userText: "user text",
        tool,
        model,
        extract: () => captured,
      }),
    );
    expect(result).toBe("VALUE");
    expect(agentLoopMock).toHaveBeenCalledTimes(1);
    // Assert the agentLoop config was constructed correctly: maxTokens, reasoning (low≠off),
    // apiKey/headers/model wired, convertToLlm + toolExecution, and the user-text payload.
    const callArgs = agentLoopMock.mock.calls[0] as unknown[];
    const messages = callArgs[0] as { role: string; content: { type: string; text: string }[] }[];
    const context = callArgs[1] as { systemPrompt: string; tools: AgentTool[] };
    const config = callArgs[2] as {
      model: Model<Api>;
      apiKey: string;
      maxTokens: number;
      reasoning?: string;
      toolExecution: string;
    };
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content[0]?.text).toBe("user text");
    expect(context.systemPrompt).toBe("SYS");
    expect(context.tools[0]).toBe(tool);
    expect(config.model).toBe(model);
    expect(config.apiKey).toBe("key");
    expect(config.maxTokens).toBe(TEST_MAX_TOKENS);
    expect(config.reasoning).toBe(TEST_THINKING_LEVEL); // low≠off → reasoning present
    expect(config.toolExecution).toBe("sequential");
  });

  it("thinkingLevel 'off' omits the reasoning field from the config", async () => {
    const tool = {
      name: "return_x",
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    } as unknown as AgentTool;
    agentLoopMock.mockImplementation(() => makeFakeStream(tool, { called: false }));
    await callLlmWithTool(
      optsFor({
        systemPrompt: "SYS",
        userText: "u",
        tool,
        model: fakeModel("m"),
        extract: () => undefined,
        thinkingLevel: "off",
      }),
    );
    const config = (agentLoopMock.mock.calls[0] as unknown[])[2] as { reasoning?: string };
    expect(config.reasoning).toBeUndefined(); // off → no reasoning key
  });

  it("auth {ok:false} → throws (FAILURE — retry/dialog), no stream call", async () => {
    const reg = mockRegistry({ getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: false }) });
    const tool = { name: "t", execute: vi.fn() } as unknown as AgentTool;
    await expect(
      callLlmWithTool(
        optsFor({
          systemPrompt: "SYS",
          userText: "u",
          tool,
          model: fakeModel("m"),
          extract: () => undefined,
          registry: reg,
        }),
      ),
    ).rejects.toThrow(/Missing API key/);
    expect(agentLoopMock).not.toHaveBeenCalled();
  });

  it("auth ok but no apiKey → throws (FAILURE — retry/dialog)", async () => {
    const reg = mockRegistry({ getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true }) }); // no apiKey
    const tool = { name: "t", execute: vi.fn() } as unknown as AgentTool;
    await expect(
      callLlmWithTool(
        optsFor({
          systemPrompt: "SYS",
          userText: "u",
          tool,
          model: fakeModel("m"),
          extract: () => undefined,
          registry: reg,
        }),
      ),
    ).rejects.toThrow(/Missing API key/);
  });

  it("stream throws → RE-THROWS (no try/catch — ; propagates to callPhaseWithRetry)", async () => {
    const tool = { name: "t", execute: vi.fn() } as unknown as AgentTool;
    agentLoopMock.mockImplementation(() => {
      const stream = {
        // biome-ignore lint/correctness/useYield: test fake — stream throws before any yield
        async *[Symbol.asyncIterator]() {
          throw new Error("boom");
        },
        async result() {
          return [];
        },
      };
      return stream;
    });
    await expect(
      callLlmWithTool(
        optsFor({
          systemPrompt: "SYS",
          userText: "u",
          tool,
          model: fakeModel("m"),
          extract: () => "X",
        }),
      ),
    ).rejects.toThrow("boom");
  });

  it("extractor returns undefined (tool never captured) → returns null", async () => {
    const tool = { name: "t", execute: vi.fn() } as unknown as AgentTool;
    agentLoopMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "agent_end", messages: [] };
      },
      async result() {
        return [];
      },
    }));
    const result = await callLlmWithTool(
      optsFor({
        systemPrompt: "SYS",
        userText: "u",
        tool,
        model: fakeModel("m"),
        extract: () => undefined,
      }),
    );
    expect(result).toBeNull();
  });

  it("onProgress receives usage.output from a message_update delta event", async () => {
    const tool = { name: "t", execute: vi.fn() } as unknown as AgentTool;
    agentLoopMock.mockImplementation(() => {
      const stream = {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "hi", partial: { usage: { output: 42 } } },
          };
          yield { type: "agent_end", messages: [] };
        },
        async result() {
          return [];
        },
      };
      return stream;
    });
    const seen: number[] = [];
    await callLlmWithTool(
      optsFor({
        systemPrompt: "SYS",
        userText: "u",
        tool,
        model: fakeModel("m"),
        extract: () => "X",
        onProgress: (t) => seen.push(t),
      }),
    );
    expect(seen).toEqual([42, 42]); // throttled call during stream + final flush
  });

  it("onProgress reports the MAX output across delta types; dip + non-number ignored (R2-20e)", async () => {
    const tool = { name: "t", execute: vi.fn() } as unknown as AgentTool;
    agentLoopMock.mockImplementation(() => {
      const stream = {
        async *[Symbol.asyncIterator]() {
          // text_delta reports 10 → tracked
          yield {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "a", partial: { usage: { output: 10 } } },
          };
          // thinking_delta reports 30 → new max
          yield {
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", delta: "b", partial: { usage: { output: 30 } } },
          };
          // toolcall_delta reports 25 (a DIP) → ignored, max stays 30
          yield {
            type: "message_update",
            assistantMessageEvent: { type: "toolcall_delta", delta: "c", partial: { usage: { output: 25 } } },
          };
          // non-number usage ("done" variant or malformed) → ignored
          yield {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "d", partial: { usage: { output: "lots" } } },
          };
          yield { type: "agent_end", messages: [] };
        },
        async result() {
          return [];
        },
      };
      return stream;
    });
    const seen: number[] = [];
    await callLlmWithTool(
      optsFor({
        systemPrompt: "SYS",
        userText: "u",
        tool,
        model: fakeModel("m"),
        extract: () => "X",
        onProgress: (t) => seen.push(t),
      }),
    );
    // Single final flush with the MAX (30); dip (25) and non-number ("lots") never reported.
    expect(seen).toEqual([10, 30]); // throttled call at 10, final flush at 30 (max)
  });

  it("a hung stream aborts via the per-call timeout", async () => {
    const tool = { name: "t", execute: vi.fn() } as unknown as AgentTool;
    // A stream that never yields (hang) but — like a real provider stream — aborts when its signal
    // fires. The per-call timeout (AbortSignal.timeout) is wired as the combined signal, so a hung
    // call rejects instead of hanging forever.
    agentLoopMock.mockImplementation((_msgs, _ctx, _cfg, signal: AbortSignal) => {
      const stream = {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => reject(new Error("aborted"));
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort, { once: true });
          });
          yield { type: "agent_end", messages: [] };
        },
        async result() {
          return [];
        },
      };
      return stream;
    });
    const tinyTimeout = 150; // ms — short so the test is fast
    const start = Date.now();
    await expect(
      callLlmWithTool(
        optsFor({
          systemPrompt: "SYS",
          userText: "u",
          tool,
          model: fakeModel("m"),
          extract: () => "X",
          timeoutMs: tinyTimeout,
        }),
      ),
    ).rejects.toThrow("aborted");
    // Resolved via the timeout (not instantly): elapsed ≈ the timeout window.
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(tinyTimeout);
    expect(elapsed).toBeLessThan(tinyTimeout + 1000); // generous upper bound
  });

  it("a truthy external signal (session shutdown) aborts the in-flight call via AbortSignal.any", async () => {
    // Exercises the `signal ? AbortSignal.any([signal, timeoutSignal]): timeoutSignal` branch
    // (llm.ts:122) — the null-signal branch is covered by the timeout test above; this covers the
    // truthy branch, proving the EXTERNAL signal is combined so session-shutdown aborts in-flight
    // captures without waiting for the timeout to elapse.
    const tool = { name: "t", execute: vi.fn() } as unknown as AgentTool;
    // Capture the combined signal passed to agentLoop so we can assert it reflects the external abort.
    let passedSignal: AbortSignal | undefined;
    agentLoopMock.mockImplementation((_msgs, _ctx, _cfg, signal: AbortSignal) => {
      passedSignal = signal;
      const stream = {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => reject(new Error("shutdown-aborted"));
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort, { once: true });
          });
          yield { type: "agent_end", messages: [] };
        },
        async result() {
          return [];
        },
      };
      return stream;
    });

    const ac = new AbortController();
    const longTimeout = 10_000; // long — proves we abort via the EXTERNAL signal, not the timeout
    // optsFor defaults signal=null; pass the EXTERNAL session-shutdown signal here to exercise the
    // truthy AbortSignal.any branch (llm.ts:122).
    const externalPromise = callLlmWithTool({
      systemPrompt: "SYS",
      userText: "u",
      tool,
      registry: mockRegistry(NO_REGISTRY_OPTS),
      model: fakeModel("m"),
      extract: () => "X",
      signal: ac.signal,
      onProgress: null,
      timeoutMs: longTimeout,
      thinkingLevel: TEST_THINKING_LEVEL,
      onDebugDelta: null,
      maxTokens: TEST_MAX_TOKENS,
    });
    // Abort the EXTERNAL signal (e.g. session shutdown) — should fire the combined signal.
    const start = Date.now();
    ac.abort();
    await expect(externalPromise).rejects.toThrow("shutdown-aborted");
    const elapsed = Date.now() - start;
    // Resolved promptly via the EXTERNAL signal, NOT the long timeout window.
    expect(elapsed).toBeLessThan(2000);
    // The combined signal passed to agentLoop reflects the external abort (AbortSignal.any wired).
    expect(passedSignal?.aborted).toBe(true);
  });
});
