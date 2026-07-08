// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyBuild, type BuildResult, type Candidate } from "./build.js";
import { appendDebug, openDebugDump } from "./debug.js";
import { readTierSnapshot } from "./decisions.js";
import { callLlmWithTool, resolveModel } from "./llm.js";
import { acquireUnderLock, type LockState } from "./lock.js";
import { log } from "./log.js";
import { PAUSED, PauseSignal, setPaused, sleep } from "./pause-state.js";
import { BUILD_SYSTEM_PROMPT, EXTRACT_SYSTEM_PROMPT } from "./prompts.js";
import { withCoordinator } from "./snippets/vendored/subscribe-to-dialog-coordinator.js";
import { forwardToRoot } from "./snippets/vendored/subscribe-to-subagent-ui-bridge.js";
import type { DecisionsConfig, TierPaths } from "./types.js";

/**
 * Check if this process is running as a subagent.
 * Returns true if mode is not TUI OR if PI_SUBAGENT_PARENT_PID is set.
 */
function isSubagentSession(ctxMode: string | null): boolean {
  if (ctxMode !== null && ctxMode !== "tui") return true;
  return process.env.PI_SUBAGENT_PARENT_PID !== undefined;
}

/** Choice constants for the exhaustion dialog (no-bare-literals convention). */
const CHOICE_CONTINUE = "Continue retrying";
const CHOICE_PAUSE = "Pause auto-catch to investigate";

const captureLog = log.child("capture");
const extractLog = log.child("extract");
const buildLog = log.child("build");

/** Serialize a tool definition to Anthropic format (what the LLM actually sees).
 * Mirrors pi-ai's Anthropic convertTools: { name, description, input_schema }.
 * The input_schema extracts `properties` and `required` from the TypeBox schema.
 */
function serializeTool(tool: AgentTool): string {
  const schema = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
  return JSON.stringify(
    {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: schema?.properties ?? {},
        required: schema?.required ?? [],
      },
    },
    null,
    2,
  );
}

interface ExtractResult {
  action: "skip" | "add";
  summary: string | null;
  detail: string | null;
}

/** Phase 1 tool: return_candidate — the model calls it to report its extraction decision. */
function makeExtractTool(): { tool: AgentTool; result: () => ExtractResult | undefined } {
  let captured: ExtractResult | undefined;
  const tool: AgentTool = {
    name: "return_candidate",
    label: "Return candidate",
    description: "Return the extracted decision candidate or skip.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("skip"), Type.Literal("add")]),
      summary: Type.Optional(Type.String()),
      detail: Type.Optional(Type.String()),
    }),
    async execute(_id, params): Promise<AgentToolResult<unknown>> {
      const p = params as { action: "skip" | "add"; summary?: string; detail?: string };
      captured = { action: p.action, summary: p.summary ?? null, detail: p.detail ?? null };
      return { content: [{ type: "text" as const, text: "ok" }], details: undefined, terminate: true };
    },
  };
  return { tool, result: () => captured };
}

/** Phase 2 tool: return_build — the model calls it to report its build decision. */
function makeBuildTool(): { tool: AgentTool; result: () => BuildResult | undefined } {
  let captured: BuildResult | undefined;
  const tool: AgentTool = {
    name: "return_build",
    label: "Return build decision",
    description: "Return the build decision for the candidate.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("insert"), Type.Literal("skip"), Type.Literal("supersede")]),
      beforePosition: Type.Optional(Type.Number()),
      supersedes: Type.Optional(Type.Array(Type.Number())),
    }),
    async execute(_id, params): Promise<AgentToolResult<unknown>> {
      const p = params as { action: "insert" | "skip" | "supersede"; beforePosition?: number; supersedes?: number[] };
      captured = {
        action: p.action,
        beforePosition: p.beforePosition ?? null,
        supersedes: p.supersedes ?? null,
      };
      return { content: [{ type: "text" as const, text: "ok" }], details: undefined, terminate: true };
    },
  };
  return { tool, result: () => captured };
}

/** Dialog options honored by the pi TUI at runtime. The SDK's ExtensionUIDialogOptions omits
 * `withAttention` (the TUI reads it), so we widen the type here (mirrors portrait's globals.ts
 * PortraitUiSelectOptions —, replaces an awkward `as Parameters<...>[2]` cast). */
interface DialogOptions {
  withAttention?: boolean;
}
/** The subset of ctx.ui autocatch needs: a select dialog honoring DialogOptions + notify. */
export interface UiDialog {
  select: (title: string, options: string[], opts?: DialogOptions) => Promise<string | undefined>;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
}

export interface AutoCatchDeps {
  config: DecisionsConfig;
  tiers: TierPaths;
  lockState: LockState;
  lockFilePath: string;
  retries: number; // per-phase retry attempts before the continue/pause dialog
  ui: UiDialog | null; // for the ui.notify/ui.select dialog (null in headless/subagent)
  mode: string | null; // pi mode (tui/rpc/json/print), null if unavailable
  // Parent dir for extract/build debug dumps (<parent>/debug). null = dumps disabled.
  debugParentDir: string | null;
  // central error reporting: stores lastError (in-memory/per-process) + notifies via ui.
  // Called on every FAILURE (exhaustion) so the user learns auto-catch broke.
  reportError: (msg: string) => void;
  onProgress: ((tokens: number, words: number) => void) | null; // receive running output tokens + word-count fallback from the capture's stream (null when not wired)
}

/**
 * Run the full two-phase pipeline for one capture unit (agentBefore + userReply).
 * NO lock during Phase 1 (extract); Phase 2 acquires the lock for the build+write.
 *
 *  ERROR HANDLING: the WHOLE capture is wrapped in a retry→dialog loop. Each LLM phase
 * retries `retries` times (exp backoff) internally (callPhaseWithRetry); on exhaustion the
 * error propagates HERE, where the continue/pause dialog is shown (once per capture, not per
 * phase). "Continue retrying" RE-RUNS THE WHOLE CAPTURE (extract+build from the raw strings
 * the candidate is not held across the dialog). "Pause" / dismissed → PauseSignal (the drain
 * stops processing but keeps the queue — no loss). Headless (ui===null) → reportError + skip.
 * Model-resolution + auth failures are FAILURES — resolveModel throws and the
 * auth check throws, both propagating into this loop. ABORT (shutdown) is NOT a failure and is
 * not retried (returns false).
 *
 * Model resolved FRESH from the setCapturedModel holder each round ( — no stale ctx; a
 * model_select between rounds is picked up).
 * Returns true if a decision was written.
 *
 * ABORT MODEL: the drain (index.ts) sets `deps.lockState.abort` to ONE
 * AbortController before calling runCapture and clears it after, so lockState.abort is always
 * the CURRENT capture's controller. callPhaseWithRetry passes the signal to the LLM calls;
 * session_shutdown (new/resume/fork/quit) aborts via cleanupOnExit → lockState.abort.abort.
 */
export async function runCapture(deps: AutoCatchDeps, agentBefore: string, userReply: string): Promise<boolean> {
  // Capture the per-capture AbortSignal ONCE. session_shutdown (quit/new/resume/fork) aborts + nulls
  // lockState.abort via cleanupOnExit; re-reading `deps.lockState.abort?.signal.aborted` each
  // iteration would see null post-abort and FAIL to short-circuit. The captured reference stays
  // aborted, so the loop terminates immediately after the in-flight attempt throws.
  const signal = deps.lockState.abort?.signal ?? null;
  const extractInput = `<agent-before>
${agentBefore}
</agent-before>

<user-reply>
${userReply}
</user-reply>`;
  captureLog.info("start");
  // Open ONE debug dump per capture (extract input+output, build input+output). Pruned to
  // backgroundCaptureDumpLimit. null debugParentDir = dumps disabled (e.g. tests that don't set it).
  const dump = deps.debugParentDir
    ? openDebugDump(deps.debugParentDir, "capture", deps.config.backgroundCaptureDumpLimit)
    : null;
  for (;;) {
    if (signal?.aborted) return false; // terminal: a shutdown aborted this capture
    try {
      // Resolve the model FRESH each round: a model_select between dialog rounds is picked up.
      // resolveModel THROWS ModelResolutionError on failure (model-resolution is a FAILURE).
      const resolved = resolveModel(deps.config.backgroundCaptureModel);
      const ex = makeExtractTool();
      // Debug: dump what the LLM sees — system prompt, tool definition, and user message (portrait style).
      if (dump) {
        appendDebug(
          dump,
          `=== EXTRACT INPUT ===
--- SYSTEM PROMPT ---
${EXTRACT_SYSTEM_PROMPT}

--- TOOL ---
${serializeTool(ex.tool)}

--- USER MESSAGE ---
${extractInput}

`,
        );
      }
      extractLog.info("phase start");
      // PHASE 1 — extract (no lock). null = skip (no decision) or abort (terminal).
      const dumpHandler = dump ? makeStreamingDump(appendDebug, dump) : null;
      const extractRes = await callPhaseWithRetry(
        deps,
        EXTRACT_SYSTEM_PROMPT,
        extractInput,
        ex.tool,
        resolved.registry,
        resolved.model,
        ex.result,
        signal,
        dumpHandler?.onChunk ?? null,
      );
      dumpHandler?.flush();
      if (!extractRes || extractRes.action === "skip" || !extractRes.summary || !extractRes.detail) {
        extractLog.info(extractRes ? "phase skip" : "phase null/abort");
        if (dump) appendDebug(dump, `\n=== EXTRACT OUTPUT ===\n${JSON.stringify(extractRes ?? null)}\n\n`);
        return false;
      }
      const candidate: Candidate = { summary: extractRes.summary, detail: extractRes.detail };
      extractLog.info(`phase candidate summary=${JSON.stringify(candidate.summary).slice(0, 80)}`);
      if (dump)
        appendDebug(
          dump,
          `\n=== EXTRACT OUTPUT ===\naction=add\nsummary: ${candidate.summary}\ndetail: ${candidate.detail}\n\n`,
        );
      // PHASE 2 — build + write (under the SQLite mutex). `acquireUnderLock` runs fn while the lock
      // is held; fn reads the store FRESH (read-modify-write atomicity). acquireUnderLock's
      // finally always releases the mutex (even if fn throws). Returns null on abort/acquire-failure.
      const wrote = await acquireUnderLock(deps.lockState, deps.lockFilePath, async () => {
        // Read all tiers ONCE under the lock and thread the snapshot into applyBuild so
        // it does NOT re-read while the cross-process mutex is held (read-modify-write stays
        // atomic — the caller owns the lock for the whole read→LLM→write sequence, ).
        const snap = readTierSnapshot(deps.tiers);
        const existing = [...snap.active, ...snap.evicted]; // active + evicted for build context (dropped excluded)
        const existingBlock = existing.map((r) => `${r.id} ${r.summary}`).join("\n") || "(none)"; // plain id (no #)
        const b = makeBuildTool();
        const buildInput = `<candidate>
${candidate.summary}
</candidate>

<existing>
${existingBlock}
</existing>`;
        buildLog.info("phase start");
        // Debug: dump what the LLM sees — system prompt, tool definition, and user message.
        if (dump) {
          appendDebug(
            dump,
            `=== BUILD INPUT ===
--- SYSTEM PROMPT ---
${BUILD_SYSTEM_PROMPT}

--- TOOL ---
${serializeTool(b.tool)}

--- USER MESSAGE ---
${buildInput}

`,
          );
        }
        const buildDumpHandler = dump ? makeStreamingDump(appendDebug, dump) : null;
        const buildRes = await callPhaseWithRetry(
          deps,
          BUILD_SYSTEM_PROMPT,
          buildInput,
          b.tool,
          resolved.registry,
          resolved.model,
          b.result,
          signal,
          buildDumpHandler?.onChunk ?? null,
        );
        buildDumpHandler?.flush();
        if (!buildRes || buildRes.action === "skip") {
          buildLog.info(buildRes ? "phase skip" : "phase null/abort");
          if (dump) appendDebug(dump, `\n=== BUILD OUTPUT ===\n${JSON.stringify(buildRes ?? null)}\n\n`);
          return false;
        }
        buildLog.info(
          `phase ${buildRes.action} beforePosition=${buildRes.beforePosition ?? "-"} supersedes=${JSON.stringify(buildRes.supersedes ?? null)}`,
        );
        if (dump)
          appendDebug(
            dump,
            `\n=== BUILD OUTPUT ===\naction: ${buildRes.action}\nbeforePosition: ${buildRes.beforePosition ?? "-"}\nsupersedes: ${JSON.stringify(buildRes.supersedes ?? null)}\n\n`,
          );
        applyBuild(deps.tiers, candidate, buildRes, deps.config.rankingEnabled, deps.config.limit, new Date(), snap);
        return true;
      });
      captureLog.info(`end wrote=${wrote === true}`);
      return wrote ?? false;
    } catch (err) {
      // Abort (shutdown) is NOT a failure — return immediately (no retry/dialog).
      if (signal?.aborted) return false;
      captureLog.error("exhausted — continue/pause dialog", err);
      // EXHAUSTION (callPhaseWithRetry re-threw after `retries` attempts) or a model-resolution/
      // auth failure (resolveModel / callLlmWithTool threw) → continue/pause dialog.
      const msg = sanitizeErrorMessage(err);
      deps.reportError(msg); // central reportError: store lastError + notify
      if (!deps.ui) return false; // headless → reportError + skip
      const ui = deps.ui;

      // Subagent → try bridge first (routes dialog to root session)
      if (isSubagentSession(deps.mode)) {
        const reply = await forwardToRoot({
          contentType: "user_decisions_error_dialog",
          payload: { message: msg },
          text: `User Decisions auto-catch failed: ${msg}`,
          timeoutMs: Infinity, // human response time unpredictable
        });
        if (reply) {
          return !!reply.payload; // true=continue loop, false/null=pause
        }
        // Bridge unavailable → reportError already called, skip dialog
        return false;
      }

      // Root session with UI → render locally
      const choice = await withCoordinator(() =>
        ui.select(
          "User Decisions auto-catch failed",
          [CHOICE_CONTINUE, CHOICE_PAUSE],
          // { withAttention: true } — the pi TUI honors it at runtime; typed via UiDialog (portrait pattern).
          { withAttention: true },
        ),
      );
      if (choice === CHOICE_CONTINUE) continue; // re-run the WHOLE capture (extract+build)
      // CHOICE_PAUSE or dismissed (undefined) → PAUSED sentinel → pause.
      setPaused(deps.tiers.active, PAUSED, process.pid);
      throw new PauseSignal();
    }
  }
}

/** Create a streaming dump that buffers deltas by kind and emits labeled blocks on type change. */
function makeStreamingDump(append: (dumpPath: string, content: string) => void, dumpPath: string) {
  let currentKind: string | null = null;
  let buffer = "";
  return {
    onChunk(kind: string, text: string) {
      if (kind !== currentKind && currentKind !== null) {
        append(dumpPath, `${labelForKind(currentKind)}: ${buffer}\n`);
        buffer = "";
      }
      currentKind = kind;
      buffer += text;
    },
    flush() {
      if (buffer && currentKind) {
        append(dumpPath, `${labelForKind(currentKind)}: ${buffer}\n`);
      }
    },
  };
}

/** Map a stream delta kind to its human-readable dump label. */
function labelForKind(kind: string): string {
  return kind === "thinking_delta" ? "Thinking" : kind === "text_delta" ? "Message" : "ToolCalls";
}

/**
 * Run ONE LLM phase with portrait-style retry (N attempts, exp backoff). On success returns the
 * result (possibly null = legitimate skip — no tool call / skip action). On ABORT (shutdown)
 * returns null (terminal — not retried). On EXHAUSTION (all attempts failed) RE-THROWS the last
 * error so runCapture's catch can show the continue/pause dialog. Model-resolution and
 * auth failures thrown by callLlmWithTool also propagate as exhaustion after retries.
 */
async function callPhaseWithRetry<R>(
  deps: AutoCatchDeps,
  system: string,
  input: string,
  tool: AgentTool,
  registry: ModelRegistry,
  model: Model<Api>,
  result: () => R | undefined,
  signal: AbortSignal | null,
  onDebugDelta: ((kind: string, text: string) => void) | null,
): Promise<R | null> {
  const timeoutMs = deps.config.backgroundCallTimeoutMs;
  const thinkingLevel = deps.config.backgroundThinkingLevel;
  const maxTokens = deps.config.backgroundMaxTokens;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= deps.retries; attempt++) {
    if (signal?.aborted) return null; // terminal: a shutdown aborted this capture
    try {
      return await callLlmWithTool({
        systemPrompt: system,
        userText: input,
        tool,
        registry,
        model,
        extract: result,
        signal,
        onProgress: deps.onProgress,
        onDebugDelta,
        timeoutMs,
        thinkingLevel,
        maxTokens,
      });
    } catch (err) {
      if (signal?.aborted) return null; // terminal: shutdown aborted this capture mid-attempt — no retry
      lastErr = err;
      captureLog.warn(`attempt ${attempt + 1}/${deps.retries + 1} failed — retrying: ${sanitizeErrorMessage(err)}`);
      if (attempt < deps.retries) {
        await sleep(Math.min(1000 * 2 ** attempt, 10000));
      }
    }
  }
  // exhausted all attempts → re-throw so runCapture shows the continue/pause dialog
  throw lastErr;
}

/**
 * Sanitize an error into a short single-line message for the dialog/notify.
 * One line + strip newlines (no control-char regex — biome flags range endpoints), 200-char cap
 * so a long stack-trace can't flood the dialog.
 */
function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\r?\n|\r/g, " ").slice(0, 200);
}
