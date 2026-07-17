// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import {
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  agentLoop,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { log } from "./log.js";

const llmLog = log.child("llm");

/**
 * Captured session model + registry — the LATEST one, refreshed on session_start/turn_end/
 * model_select (mirrors avtc-pi-portrait's captureModel). Module-scoped: the auto-catch
 * pipeline resolves the model FRESH from here at drain time rather than trusting a ctx
 * captured at enqueue time (ctx.model can go stale — e.g. a model_select between enqueue
 * and drain). Lost on /reload but recaptured on the next session_start before any capture.
 */
let _sessionModel: Model<Api> | null = null;
let _modelRegistry: ModelRegistry | null = null;

/**
 * Thrown by `resolveModel` when no usable model can be resolved (override not found in the
 * registry, or no session model captured yet). classifies model-resolution failure
 * as a FAILURE (retry → dialog → pause), so `resolveModel` throws this rather than returning
 * null — the error propagates into the capture's retry/dialog path.
 */
export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

/** Set the latest captured model + registry — called from index.ts captureModel on session/turn/model events. */
export function setCapturedModel(model: Model<Api> | undefined, modelRegistry: ModelRegistry | undefined): void {
  if (model) _sessionModel = model;
  if (modelRegistry) _modelRegistry = modelRegistry;
}

/** Test seam: clear the captured-model holder (avoids cross-test leakage). */
export function resetCapturedModel(): void {
  _sessionModel = null;
  _modelRegistry = null;
}

/**
 * Resolve the model: explicit "provider/id" override from config, else the captured
 * session model (read FRESH from the holder). THROWS `ModelResolutionError` on failure (design
 * model-resolution failure is a FAILURE → retry → dialog → pause, NOT a silent skip).
 */
export function resolveModel(modelOverride: string | null): { model: Model<Api>; registry: ModelRegistry } {
  if (modelOverride) {
    const slash = modelOverride.indexOf("/");
    if (slash <= 0 || !_modelRegistry) throw new ModelResolutionError(`Could not resolve model "${modelOverride}"`);
    const found = _modelRegistry.find(modelOverride.slice(0, slash), modelOverride.slice(slash + 1));
    if (!found) throw new ModelResolutionError(`Model "${modelOverride}" not found in registry`);
    return { model: found, registry: _modelRegistry };
  }
  if (!_sessionModel || !_modelRegistry)
    throw new ModelResolutionError("No model configured for user-decisions auto-catch");
  return { model: _sessionModel, registry: _modelRegistry };
}

/** Options for {@link callLlmWithTool} — a single options object so the 11 parameters are named
 * (arg-order-safe) and self-documenting at every call site. */
export interface CallLlmOptions<T> {
  systemPrompt: string;
  userText: string;
  tool: AgentTool;
  registry: ModelRegistry;
  model: Model<Api>;
  /** Extract the captured result from the tool's side effect; returns undefined when the model
   * produced no tool call / no decision (a legitimate skip). */
  extract: () => T | undefined;
  /** Optional session-shutdown abort signal; combined with the per-call timeout. */
  signal: AbortSignal | null;
  /** Optional receiver of provider-reported running output tokens + word-count fallback
   * from the capture's OWN stream events (NOT the session emitter — a standalone agentLoop
   * does not forward to `message_update`). Used by the status tracker. */
  onProgress: ((tokens: number, words: number) => void) | null;
  /** Optional debug sink that receives every streaming delta for debug dumps.
   * Called with the delta kind (thinking/text/toolcall) and the delta text.
   * Preserves stream order so thinking, text, and tool-call deltas are interleaved correctly. */
  onDebugDelta: ((kind: string, text: string) => void) | null;
  /** Per-call timeout that aborts the call if the LLM hangs (mirrors portrait's AbortSignal.timeout). */
  timeoutMs: number;
  thinkingLevel: ModelThinkingLevel;
  maxTokens: number;
}

/**
 * Run one agentLoop turn with a single extraction tool; return the captured result,
 * or null when the model produced no tool call / no decision (a legitimate skip).
 * Errors (stream failure, timeout, abort) PROPAGATE to the caller so callWithRetry owns
 * retry/backoff/dialog/pause. Mirrors portrait's callPortraitLlm pattern.
 */
export async function callLlmWithTool<T>(opts: CallLlmOptions<T>): Promise<T | null> {
  const {
    systemPrompt,
    userText,
    tool,
    registry,
    model,
    extract,
    signal,
    onProgress,
    onDebugDelta,
    timeoutMs,
    thinkingLevel,
    maxTokens,
  } = opts;
  const auth = await registry.getApiKeyAndHeaders(model);
  // Missing auth is a FAILURE (auth failure → retry → dialog → pause), so THROW
  // rather than silently skip. Propagates into callPhaseWithRetry's catch → retry → dialog.
  if (!auth.ok || !auth.apiKey) throw new Error(`Missing API key / auth for model "${model.id}"`);

  // Combine per-call timeout (prevents hangs) with session-shutdown abort (cleanup).
  // AbortSignal.any fires when EITHER signal fires — timeout kills hung LLM calls,
  // session shutdown kills in-flight captures on quit/new/reload.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  llmLog.info(`call start model=${model.id} timeout=${timeoutMs}ms maxTokens=${maxTokens} thinking=${thinkingLevel}`);
  const started = Date.now();

  const context: AgentContext = { systemPrompt, messages: [], tools: [tool] };
  const config: AgentLoopConfig = {
    model,
    apiKey: auth.apiKey,
    headers: auth.headers,
    maxTokens,
    ...(thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    convertToLlm: (msgs: AgentMessage[]) => msgs as unknown as Message[],
    toolExecution: "sequential",
  };
  const stream = agentLoop(
    [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
    context,
    config,
    combined,
  );
  // Read usage from the capture's OWN stream (mirrors portrait llm-call.ts:308). `message_update`
  // on the session emitter is the MAIN session's stream — a standalone agentLoop never forwards
  // to it, so tokens MUST be captured here from the local iterator. Track the MAX running output
  // (providers report monotonically, but guard against any dip) and do a final flush so the sink
  // sees the complete count (mirrors portrait llm-call.ts:318-324).
  // Word count fallback: count whitespace-separated words from delta text when
  // the provider doesn't stream usage.output per event (vLLM reports only in the final `done`).
  let tokensSoFar = 0;
  let wordsSoFar = 0;
  // Throttle the onProgress callback to ~500ms so a fast stream doesn't flood the status bar.
  //  Function-local last-write timestamp (fine for the single in-flight capture per process).
  let _lastProgressCallAt = 0;
  const PROGRESS_CALL_THROTTLE_MS = 500;
  const fireProgress = () => {
    if (!onProgress) return;
    const now = Date.now();
    if (now - _lastProgressCallAt >= PROGRESS_CALL_THROTTLE_MS) {
      _lastProgressCallAt = now;
      onProgress(tokensSoFar, wordsSoFar);
    }
  };

  try {
    for await (const event of stream) {
      if (event.type === "message_update") {
        const sub = event.assistantMessageEvent;
        // `partial.usage.output` lives on the delta variants — narrow before access (the other
        // variants like "done"/"start" have no `partial`). Mirrors portrait llm-call.ts:315-319.
        if (sub.type === "text_delta" || sub.type === "thinking_delta" || sub.type === "toolcall_delta") {
          // Emit debug deltas for debug dumps (preserves stream order)
          if (typeof sub.delta === "string") {
            onDebugDelta?.(sub.type, sub.delta);
          }
          // Word-count fallback: count whitespace-separated words from delta text (portrait pattern)
          if (typeof sub.delta === "string") {
            const trimmed = sub.delta.trim();
            if (trimmed.length > 0) wordsSoFar += trimmed.split(/\s+/).length;
          }
          const usage = sub.partial?.usage;
          if (usage && typeof usage.output === "number" && usage.output > tokensSoFar) {
            tokensSoFar = usage.output;
            // Throttled token-progress log (NOT onProgress): lets the log alone show whether the
            // model is advancing or stuck — the "infinite invocation without progress" signal.
            logProgressThrottled(tokensSoFar);
          }
          fireProgress(); // throttled status update during streaming
        }
      }
    }
    await stream.result();
  } catch (err) {
    llmLog.error(`call failed model=${model.id} elapsed=${Date.now() - started}ms`, err);
    throw err;
  }
  // Final flush so the sink sees the complete count (mirrors portrait llm-call.ts:322)
  onProgress?.(tokensSoFar, wordsSoFar);
  const result = extract() ?? null; // no tool call / no decision extracted → legitimate skip
  llmLog.info(
    `call ok model=${model.id} elapsed=${Date.now() - started}ms tokens=${tokensSoFar} words=${wordsSoFar} extracted=${
      result ? "yes" : "no(skip)"
    }`,
  );
  return result;
}

/** Throttle the per-call token-progress log to ~500ms so a fast stream doesn't flood the log.
 *  Module-scoped last-write timestamp (fine for the single in-flight capture per process). */
let _lastProgressLogAt = 0;
const PROGRESS_LOG_THROTTLE_MS = 500;
function logProgressThrottled(tokens: number): void {
  const now = Date.now();
  if (now - _lastProgressLogAt >= PROGRESS_LOG_THROTTLE_MS) {
    _lastProgressLogAt = now;
    llmLog.info(`streaming tokens=${tokens}`);
  }
}
