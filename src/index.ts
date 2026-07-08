// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCapture, type UiDialog } from "./autocatch.js";
import { isAskUserQuestionResult, isFirstEntryAskUserQuestion, lastAssistantText } from "./autocatch-hooks.js";
import { runDetailsCommand, runListCommand } from "./commands.js";
import { isContinuation, isExtensionMessage, stripSkillBlocks } from "./filtering.js";
import { renderInjection } from "./injection.js";
import { setCapturedModel } from "./llm.js";
import { cleanupOnExit, type LockState, makeLockState } from "./lock.js";
import { log } from "./log.js";
import { dataDir, isRootSession, lockDbPath, resolveActivePath, sessionsDir, tierPaths } from "./paths.js";
import { PAUSED, PauseSignal, RESUMED, readPauseState, setPaused } from "./pause-state.js";
import { persistCacheSnapshot, restoreCacheSnapshot } from "./persistence.js";
import { getDecisionsSettings, initDecisionsSettings } from "./settings-ui.js";

import { subscribeToDialogCoordinator, withCoordinator } from "./snippets/vendored/subscribe-to-dialog-coordinator.js";
import { type RootHandler, subscribeToUiBridge } from "./snippets/vendored/subscribe-to-subagent-ui-bridge.js";
import { countTotalActive, invalidateCountCache, renderStatus, type StatusSnapshot, snapshot } from "./status.js";
import { contributeExtraTools } from "./subagent.js";
import { registerDecisionTools, type ToolRuntime } from "./tools.js";
import type { DecisionsConfig, TierPaths } from "./types.js";

/**
 * Reload-safe wiring guard. pi re-evaluates extension modules fresh on /reload (jiti
 * moduleCache:false) and creates a new Extension with empty handlers, but globalThis PERSISTS —
 * so an un-reset guard would short-circuit the re-wire and leave the extension dead after reload.
 * The flag is set on first activate and reset on session_shutdown so a fresh activate re-wires.
 * Lets the package be safely bundled into the avtc-pi umbrella AND installed standalone.
 */
const WIRED_KEY = "__avtcPiUserDecisionsWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

/** Footer status-bar slot key + clear value (no-bare-literals convention). */
const STATUS_KEY = "user-decisions";
const STATUS_CLEAR = "";
/** Throttled poll interval for TotalActive freshness (catches subagent writes). */
const STATUS_POLL_MS = 2000;

const queueLog = log.child("queue");

interface SessionRuntime {
  config: DecisionsConfig;
  tiers: TierPaths;
  activePath: string;
  lockState: LockState;
  lockFilePath: string;
  cache: string | null; // rendered injection section (null = omit)
  toolsRegistered: boolean;
  cwd: string; // ctx.cwd captured at buildRuntime (consistent cwd source)
}

interface QueueItem {
  agentBefore: string;
  userReply: string;
}

interface GlobalState {
  runtime: SessionRuntime | null;
  // Auto-catch capture queue: captures QUEUED and processed one at a time per
  // process (sequential). Cross-process builds serialize on the SQLite lock. The queue holds ONLY
  // raw hook strings (never a captured ctx — ctx goes stale after /reload/new/fork).
  captureQueue: QueueItem[];
  draining: boolean;
  ui: ExtensionContext["ui"] | null;
  mode: ExtensionCommandContext["mode"] | null;
  // Token tracker for the in-flight capture's streaming usage. On globalThis so the drain
  // (a module-level fn) can read/update it and it survives /reload.
  tracker: TokenTracker;
  // Cached TotalActive. Recounted on capture-complete + poll ticks; reused while streaming
  // (count can't change mid-capture; avoids re-reading files on every throttled token refresh).
  cachedTotalActive: number | null;
  // Cached pause flag. Pause is written only by /pause + /resume in THIS process, so the
  // cache is set directly there and the ~2/s streaming refresh never re-reads the state file.
  cachedPaused: boolean | null;
}

// State on globalThis (survives /reload — mirrors portrait's __piPortrait). Single source of runtime
// state: the SessionRuntime lives at state.runtime so both it and the queue survive /reload and
// the drain reads a LIVE runtime. (NO `abort` field — the capture AbortController lives on
// runtime.lockState.abort;.) Lazily created on first access (test harnesses delete the
// key between tests; module-load init alone is not enough).
const G = globalThis as Record<string, unknown>;

/**
 * Process-exit teardown (stable reference so Node dedupes the listener across extension
 * re-loads — inline arrows leak one listener per factory call, tripping MaxListenersExceeded).
 */
function exitHandler(): void {
  const rt = state().runtime;
  if (rt) cleanupOnExit(rt.lockState);
}

function state(): GlobalState {
  if (!G.__piUserDecisions) {
    G.__piUserDecisions = {
      runtime: null,
      captureQueue: [],
      draining: false,
      ui: null,
      mode: null,
      tracker: { tokens: 0, words: 0, streaming: false, lastFlush: 0 },
      cachedTotalActive: null,
      cachedPaused: null,
    } satisfies GlobalState;
  }
  return G.__piUserDecisions as GlobalState;
}

function buildRuntime(ctx: ExtensionContext): SessionRuntime | null {
  // settings-ui reloads on session_start (registration-time + per-session); reads are live.
  const config = getDecisionsSettings();
  // captureMode "none" is the kill switch (replaces the removed `enabled: false`): no capture,
  // no tools, no injection, no status.
  if (config.captureMode === "none") return null;
  const sessionId = ctx.sessionManager.getSessionId();
  const activePath = resolveActivePath(ctx.cwd, sessionId);
  if (!activePath) return null; // subagent without env var → degraded
  const tiers = tierPaths(activePath, config.rankingEnabled);
  const lockState = makeLockState();
  const lockFilePath = lockDbPath(activePath);
  const cache = config.injectIntoSystemPromptEnabled
    ? renderInjection(tiers, config.rankingEnabled, config.limit)
    : null;
  return { config, tiers, activePath, lockState, lockFilePath, cache, toolsRegistered: false, cwd: ctx.cwd };
}

function toolRuntime(rt: SessionRuntime): ToolRuntime {
  return { config: rt.config, tiers: rt.tiers, lockState: rt.lockState, lockFilePath: rt.lockFilePath };
}

/** Tracks live token/word usage during a streaming capture (throttled ~500ms).
 * `words` is the whitespace-separated word count from delta text — fallback when the
 * provider doesn't stream usage output tokens. */
interface TokenTracker {
  tokens: number;
  words: number;
  streaming: boolean;
  lastFlush: number;
}

const TOKEN_THROTTLE_MS = 500;

/** Refresh the footer status bar from the live store + queue + tracker (lock-free).
 * While STREAMING, reuse the cached TotalActive (count can't change mid-capture);
 * the poll timer + capture-complete events keep the cache fresh, so throttled token refreshes
 * during streaming skip the file read. */
function refreshStatus(st: GlobalState): void {
  const rt = st.runtime;
  if (!rt || !st.ui) return;
  let totalActive = st.cachedTotalActive;
  if (!st.tracker.streaming || totalActive === null) {
    // Not streaming (or cache cold) → recount + cache. While streaming the count is frozen, so
    // the cache stays valid until the capture writes and the capture-complete refresh recounts.
    totalActive = countTotalActive(rt.tiers);
    st.cachedTotalActive = totalActive;
  }
  // Pause cache: use the cached flag when warm; read the state file only on the first tick
  // (cache cold) — /pause + /resume set the cache directly, so the streaming refresh never re-reads.
  let paused = st.cachedPaused;
  if (paused === null) {
    paused = readPauseState(rt.activePath).paused;
    st.cachedPaused = paused;
  }
  const snap: StatusSnapshot = snapshot(
    rt.config,
    rt.tiers,
    rt.activePath,
    st.captureQueue.length,
    st.tracker.tokens,
    st.tracker.words,
    totalActive,
    paused,
  );
  st.ui.setStatus(STATUS_KEY, renderStatus(rt.config, snap, st.tracker.streaming));
}

/**
 * central error reporting: notify the user immediately (there is no status command to
 * surface lastError; portrait likewise has no status command and notifies inline).
 * Called on every auto-catch FAILURE (exhaustion / model-resolution / auth) right before the
 * continue/pause dialog. Mirrors portrait's reportProfilingError.
 */
function reportError(msg: string): void {
  const st = state();
  if (st.ui) st.ui.notify(`User Decisions auto-catch failed: ${msg}`, "error");
}

/** Cheap mode gate used at the TOP of every background-capture hook: bail before any
 * work (type guards, answer formatting, branch walk) when the session isn't in background mode.
 * In agent/none mode the hooks become no-ops on the first line. */
function isBackgroundMode(): boolean {
  const rt = state().runtime;
  return rt?.config.captureMode === "background";
}

/** Enqueue a capture and kick the drain. Mode gate here. */
function enqueueCapture(agentBefore: string, userReply: string): void {
  const st = state();
  const rt = st.runtime;
  if (rt?.config.captureMode !== "background") return; // mode gate
  st.captureQueue.push({ agentBefore, userReply });
  queueLog.info(`enqueue depth=${st.captureQueue.length}`);
  void drain();
}

/** Sequential drain — one capture in flight; re-entry guarded by `draining`. */
async function drain(): Promise<void> {
  const st = state();
  if (st.draining) return; // a drain is already running — it picks up the new item on its next iteration
  st.draining = true;
  queueLog.info("drain start");
  try {
    while (st.captureQueue.length > 0) {
      const item = st.captureQueue.shift() as QueueItem;
      const rt = st.runtime;
      if (rt?.config.captureMode !== "background") {
        st.captureQueue.length = 0;
        break;
      } // session replaced/disabled — drop the rest
      // Honor a persisted pause: while paused the drain SKIPS processing but captures still
      // enqueue (no loss). Re-enqueue this item at the front and stop; /user-decisions:resume
      // clears paused and re-triggers drain to flush the backlog.
      if (readPauseState(rt.activePath).paused) {
        st.captureQueue.unshift(item); // put it back at the front
        break; // stop draining until resumed
      }
      // ONE AbortController for the whole capture, on lockState.abort (backs lock-acquire + LLM calls).
      // (PauseSignal from callWithRetry also stops the drain via the catch below)
      rt.lockState.abort = new AbortController();
      st.tracker.streaming = true; // show the in-processing segment + tokens while streaming
      queueLog.info(`dequeue depth=${st.captureQueue.length}`);
      refreshStatus(st);
      try {
        // runCapture resolves the model FRESH from the holder; deps built from the LIVE runtime.
        // onProgress receives the capture's OWN running output tokens (from its standalone agentLoop
        // stream — NOT the session emitter, which a standalone agentLoop never forwards to). Throttled
        // to ~500ms to avoid flooding the shared status bar.
        await runCapture(
          {
            config: rt.config,
            tiers: rt.tiers,
            lockState: rt.lockState,
            lockFilePath: rt.lockFilePath,
            retries: rt.config.backgroundRetries,
            debugParentDir: dataDir(rt.cwd),
            // ctx.ui's select takes the SDK's narrower ExtensionUIDialogOptions (omits withAttention);
            // widen once at this boundary so runCapture can pass { withAttention: true } untyped.
            ui: st.ui as UiDialog | null,
            mode: st.mode,
            reportError,
            onProgress: (tokens, words) => {
              st.tracker.tokens = tokens;
              st.tracker.words = words;
              const now = Date.now();
              if (now - st.tracker.lastFlush >= TOKEN_THROTTLE_MS) {
                st.tracker.lastFlush = now;
                refreshStatus(st);
              }
            },
          },
          item.agentBefore,
          item.userReply,
        );
      } catch (err) {
        if (err instanceof PauseSignal) break; // user paused — stop draining; remaining + future items stay queued
        // a non-Pause throw here is catastrophic — log + continue the drain
        if (st.ui) st.ui.notify("User Decisions auto-catch: capture failed", "error");
      } finally {
        rt.lockState.abort = null; // clear so a later session_shutdown doesn't abort a finished capture
        st.tracker.streaming = false; // capture done — stop the in-processing segment
        st.tracker.tokens = 0;
        st.tracker.words = 0;
        refreshStatus(st); // TotalActive likely changed (a decision was written)
      }
    }
  } finally {
    st.draining = false;
    queueLog.info("drain end");
  }
}

// ── UI bridge ────────────────────────────────────────────────────────────────

/** Content type for error-dialog bridge messages. */
const ERROR_DIALOG_CONTENT_TYPE = "user_decisions_error_dialog";

/** Root-side handler: render the continue/pause dialog for subagent error reports. */
const errorHandler: RootHandler<
  {
    ui: {
      select: (title: string, options: string[], opts?: { withAttention?: boolean }) => Promise<string | undefined>;
    };
  },
  { message?: string }
> = async (input) => {
  const title = input.payload.message
    ? `User Decisions auto-catch failed: ${input.payload.message}`
    : "User Decisions auto-catch failed";
  const choice = await withCoordinator(() =>
    input.ctx.ui.select(title, ["Continue retrying", "Pause auto-catch to investigate"], {
      withAttention: true,
    }),
  );
  return choice === "Continue retrying"; // true=continue, false/null=pause
};

export default function decisionsExtension(pi: ExtensionAPI): void {
  const g = globalThis as GlobalWithWired;
  if (g[WIRED_KEY]) return;
  g[WIRED_KEY] = true;

  // Storage bootstrap at load — runs once, before any lock/file work.
  fs.mkdirSync(sessionsDir(process.cwd()), { recursive: true });

  // Wire UI bridge — registers error-dialog handler + stores sendAndWait
  subscribeToUiBridge(pi, ERROR_DIALOG_CONTENT_TYPE, errorHandler);

  // Subscribe to the cross-extension dialog coordinator so the continue/pause dialogs queue
  // behind any open modal instead of stealing focus. No-op if avtc-pi-ui-components is not installed.
  subscribeToDialogCoordinator(pi);

  // Register the /user-decisions:settings command + modal and create the settings handle. Loads
  // settings now (registration time) and on every session_start (its handler runs before the
  // buildRuntime handler below, so getDecisionsSettings() is fresh when buildRuntime reads it).
  initDecisionsSettings(pi);

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    const st = state();
    // settings-ui reloaded settings for this session via its own session_start handler (registered
    // before this one); buildRuntime reads the fresh values via getDecisionsSettings().
    st.runtime = buildRuntime(ctx);
    st.ui = ctx.ui ?? null;
    st.mode = ctx.mode ?? null;
    st.cachedTotalActive = null; // new/changed session store → invalidate the TotalActive cache
    st.cachedPaused = null; // new session → pause cache cold (re-read on first refresh)
    invalidateCountCache(); // new session → mtime cache is stale
    setCapturedModel(ctx.model ?? undefined, ctx.modelRegistry ?? undefined);
    const rt = st.runtime;

    refreshStatus(st);
    if (!rt) return;

    // --- Fork-state cache propagation ---
    // rt is non-null past this point (buildRuntime returned a runtime; captureMode !== "none").
    // : restore only on startup (subagent child) / fork (in-process). New/reload/resume read fresh
    // from file (buildRuntime already set rt.cache from file). Restoring overrides rt.cache with the
    // parent's snapshot. append rule: append ONLY when the cache was freshly read from file.
    let restored = false;
    if (event.reason === "startup") {
      const snapshot = restoreCacheSnapshot(ctx);
      if (snapshot) {
        rt.cache = snapshot.content;
        restored = true; // child: restored from parent's snapshot → no append
      }
      // else: parent first start (no entry yet) → restored stays false → appends below
    } else if (event.reason === "fork") {
      // In-process fork (: "restore (decisions)"). buildRuntime just overwrote
      // rt.cache with a fresh file read; the restore is the AUTHORITATIVE H1 mechanism that
      // guarantees rt.cache is byte-identical to the snapshotted bytes (not an optional backstop).
      // Do NOT remove it — portrait's fork path reuses in-memory instead (different mechanic, same
      //  row); decisions can't because buildRuntime already clobbered rt.cache. Fork NEVER appends.
      const snapshot = restoreCacheSnapshot(ctx);
      if (snapshot) rt.cache = snapshot.content;
      restored = true;
    }
    // Append only when we read fresh from file (startup-no-entry / new / reload / resume).
    if (!restored) {
      persistCacheSnapshot(pi, rt.cache);
    }
    // --- end fork-state ---

    // Root sets the env var for the PI_* cascade to subagents.
    if (isRootSession()) {
      process.env.PI_DECISIONS_SESSION_FILE = rt.activePath;
      // only the root contributes user_decision_* to TOOLS_ADD (subagents inherit via cascade).
      // Per-mode set: agent → add+list+detail; background → list+detail (read-only).
      // "none" never builds a runtime (buildRuntime kill switch), so it never reaches here.
      contributeExtraTools(rt.config.captureMode === "agent");
    }
    // Register the agent tools — agent mode gets add+list+detail; background gets
    // list+detail (read-only; the pipeline owns all writes). Config-aware variant resolved at registration.
    if (!rt.toolsRegistered) {
      registerDecisionTools(
        pi,
        () => {
          const rt = state().runtime;
          return rt ? toolRuntime(rt) : null;
        },
        {
          allowAdd: rt.config.captureMode === "agent",
          onAdd: () => refreshStatus(state()), // agent mode: no poll timer, refresh after each write
        },
      );
      rt.toolsRegistered = true;
    }
    // Throttled lock-free poll (~2s) refreshes TotalActive to catch subagent writes that don't
    // notify the main session. Only needed in background mode — agent mode writes
    // come from the user_decision_add tool which refreshes status immediately after the write.
    if (rt.config.captureMode === "background") {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => refreshStatus(state()), STATUS_POLL_MS);
    }
    // Kick the drain (no-op if already draining — the old loop picks up fresh runtime/queue on its
    // next iteration; do NOT reset `draining`, which would let a second drain clobber lockState.abort).
    void drain();
  });

  // --- Auto-catch pipeline ---
  // Free-text turns: capture on before_agent_start when the user's prompt is settled.
  // The user reply is event.prompt directly; aUQ answers are handled separately by the
  // tool_result handler above.
  // NOTE: registered BEFORE the injection handler so the injection result (systemPrompt)
  // is not overwritten by this handler's void return.
  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!isBackgroundMode()) return; // hoisted gate — bail before any work in agent/none mode
    const userReply = event.prompt;
    if (!userReply || userReply.trim().length === 0) return;
    // Skip bash (!, !!) and slash commands — these don't go to the agent.
    if (userReply.trimStart().startsWith("!") || userReply.trimStart().startsWith("/")) return;
    // Skip if the last user entry is an aUQ tool answer — handled by tool_result handler.
    if (isFirstEntryAskUserQuestion(ctx)) return;
    // Skip extension-generated follow-up messages (compaction, phase transitions, etc.).
    if (isExtensionMessage(userReply)) return;
    const agentBefore = lastAssistantText(ctx);
    if (!agentBefore) return;
    enqueueCapture(agentBefore, userReply);
  });

  // Steer/followUp messages during streaming: before_agent_start doesn't fire mid-turn,
  // so we use the input event with streamingBehavior set. Buffer consecutive steers and
  // flush on pause (debounce) so they're captured as one concatenated reply.
  // Steer messages during streaming: accumulate text from input(event.streamingBehavior),
  // capture at the first message_end(role=assistant). Steer messages are NOT on the
  // branch yet (they're in Pi's internal _steeringMessages queue), so we use our own buffer.
  // Cache agentBefore at input time (branch still has the correct preceding agent text).
  const steerBuffer = { ab: null as string | null, chunks: [] as string[] };
  pi.on("input", async (event, ctx: ExtensionContext) => {
    if (!isBackgroundMode()) return;
    if (!event.streamingBehavior) return;
    const text = event.text;
    if (!text || text.trim().length === 0) return;
    steerBuffer.chunks.push(text);
    // Cache agentBefore on first steer (subsequent steers reuse the same agentBefore)
    if (steerBuffer.chunks.length === 1) {
      steerBuffer.ab = lastAssistantText(ctx) ?? null;
    }
  });
  pi.on("message_end", async (event, _ctx: ExtensionContext) => {
    if (!isBackgroundMode()) return;
    if (event.message?.role !== "assistant") return;
    if (steerBuffer.chunks.length === 0) return;
    const numChunks = steerBuffer.chunks.length;
    const reply = steerBuffer.chunks.join("\n\n");
    const ab = steerBuffer.ab;
    steerBuffer.chunks = [];
    steerBuffer.ab = null;
    if (!ab) return;
    // Strip skill blocks, then skip continuations and extension-generated messages in steer input.
    const filteredReply = stripSkillBlocks(reply);
    if (!filteredReply) return;
    if (isContinuation(filteredReply) || isExtensionMessage(filteredReply)) return;
    queueLog.info(`steer flush: ${numChunks} chunk(s) → capture`);
    enqueueCapture(ab, filteredReply);
  });

  // ask_user_question answers: the question is the agent's message, the answer is the user's.
  // Cache agentBefore on the first tool_result (when the branch still has the preceding
  // agent text) and reuse it for subsequent aUQ calls in the same turn. Clear on session_shutdown.
  const auqBuffer = { agentText: null as string | null };
  pi.on("tool_result", async (event, ctx: ExtensionContext) => {
    if (!isBackgroundMode()) return; // hoisted gate — bail before any work in agent/none mode
    if (!isAskUserQuestionResult(event)) return;
    const details = (event as { details?: { cancelled?: boolean; answers?: Record<string, string> } }).details;
    if (!details || details.cancelled) return; // aUQ cancelled (Esc) — bail
    const answers = details.answers ?? {};
    const entries = Object.entries(answers);
    // Cache agentText on first aUQ call, but also update if new text appears on the branch
    // (e.g., agent adds text between tool calls). This handles the case where the agent
    // has text + tool call 1, then text + tool call 2.
    const currentAgentText = lastAssistantText(ctx);
    if (currentAgentText) {
      auqBuffer.agentText = currentAgentText;
    }
    const agentQuestions = entries.map(([question], idx) => `Q${idx + 1}: ${question}`).join("\n");
    const agentBefore = auqBuffer.agentText ? `${auqBuffer.agentText}\n\n${agentQuestions}` : agentQuestions;
    const reply = entries.map(([_question, answer], idx) => `Answer to Q${idx + 1}: ${answer}`).join("\n");
    if (!reply.trim()) return;
    enqueueCapture(agentBefore, reply);
  });

  pi.on("session_compact", async () => {
    const rt = state().runtime;
    if (!rt?.config.injectIntoSystemPromptEnabled) return; // injection disabled → skip
    rt.cache = renderInjection(rt.tiers, rt.config.rankingEnabled, rt.config.limit); // NO LLM
    persistCacheSnapshot(pi, rt.cache); //  / — always appends (file-read refresh)
  });

  pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
    const rt = state().runtime;
    // captureMode === "none" builds no runtime. Gate on the injection toggle + non-empty cache.
    if (!rt?.config.injectIntoSystemPromptEnabled || rt.cache == null) return undefined;
    return { systemPrompt: (event.systemPrompt ?? "") + rt.cache };
  });

  // Keep the model holder current so the drain resolves a fresh model, not a stale ctx snapshot.
  // One named handler reused by turn_end + model_select (was duplicated inline arrows).
  const captureModel = (_event: unknown, ctx: ExtensionContext): void =>
    setCapturedModel(ctx.model ?? undefined, ctx.modelRegistry ?? undefined);
  pi.on("turn_end", captureModel);
  pi.on("model_select", captureModel);

  // session_shutdown by reason (amends). reload keeps the queue + lets the in-flight finish
  // (it uses strings + the holder, no stale ctx; the in-flight's own finally releases the lock
  // do NOT cleanupOnExit, which would abort lockState.abort and kill the in-flight).
  // new/resume/fork/quit clear the queue + abort the in-flight + release the mutex.
  pi.on("session_shutdown", async (event: { reason?: string }) => {
    const st = state();
    const reason = event.reason ?? "quit";
    // Flush any pending steer chunks before clearing the queue.
    if (steerBuffer.chunks.length > 0 && steerBuffer.ab) {
      const reply = steerBuffer.chunks.join("\n\n");
      const ab = steerBuffer.ab;
      steerBuffer.chunks = [];
      steerBuffer.ab = null;
      queueLog.info("[diag] session_shutdown: flushing steer capture");
      const shutdownReply = stripSkillBlocks(reply);
      if (shutdownReply && !isContinuation(shutdownReply) && !isExtensionMessage(shutdownReply)) {
        enqueueCapture(ab, shutdownReply);
      }
    }
    // Clear aUQ buffer so the next turn starts fresh.
    auqBuffer.agentText = null;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (reason === "reload") {
      if (st.ui) st.ui.setStatus(STATUS_KEY, STATUS_CLEAR); // clear status bar only; queue + in-flight untouched
      return; // globalThis survives reload — queue + runtime preserved
    }
    st.captureQueue.length = 0;
    if (st.ui) st.ui.setStatus(STATUS_KEY, STATUS_CLEAR);
    if (st.runtime) cleanupOnExit(st.runtime.lockState);
  });

  // Teardown on process exit. Safe even if no lock was ever acquired.
  // Guard on globalThis so only ONE module instance registers (vitest per-file module graphs
  // each create a fresh exitHandler; without this guard each file leaks a listener).
  if (!G.__piUserDecisionsExitRegistered) {
    G.__piUserDecisionsExitRegistered = true;
    process.on("exit", exitHandler);
  }

  // --- Commands (pause/resume) — root session only. (status command removed:
  // it duplicated the status bar; its only unique value, lastError, is already shown by the
  // error dialog/notify when the failure happens — matches portrait, which has no status command.) ---
  pi.registerCommand?.("user-decisions:pause", {
    description: "Pause auto-processing of captured user decisions",
    handler: async () => {
      if (!isRootSession()) return; // root session only (mirror portrait's lock-holder gate)
      const st = state();
      const rt = st.runtime;
      if (rt) {
        setPaused(rt.tiers.active, PAUSED, process.pid);
        st.cachedPaused = true; // set the cache directly (this process is the only writer)
        refreshStatus(st);
      }
    },
  });
  pi.registerCommand?.("user-decisions:resume", {
    description: "Resume auto-processing of captured user decisions",
    handler: async () => {
      if (!isRootSession()) return; // root session only
      const st = state();
      const rt = st.runtime;
      if (!rt) return;
      setPaused(rt.tiers.active, RESUMED, process.pid);
      st.cachedPaused = false; // set the cache directly (this process is the only writer)
      void drain(); // kick the drain to process queued captures
    },
  });

  // --- Browse commands: list/detail the store via ui.notify (read-only, lock-free — same path as
  // the agent tools). Root session only (the store is root-session-scoped; subagents get the
  // tools via ). Available in agent AND background modes (none = no runtime = no-op). ---
  pi.registerCommand?.("user-decisions:list", {
    description: "List user decisions (optionally filtered by a substring)",
    handler: async (args: string) => {
      if (!isRootSession()) return;
      const rt = state().runtime;
      const ui = state().ui;
      if (!rt || !ui) return;
      const { text, error } = runListCommand(toolRuntime(rt), args);
      ui.notify(text, error ? "error" : "info");
    },
  });
  pi.registerCommand?.("user-decisions:details", {
    description: "Show a user decision's full details by id",
    handler: async (args: string) => {
      if (!isRootSession()) return;
      const rt = state().runtime;
      const ui = state().ui;
      if (!rt || !ui) return;
      const { text, error } = runDetailsCommand(toolRuntime(rt), args);
      ui.notify(text, error ? "error" : "info");
    },
  });

  // Reload-safe teardown: reset the wiring flag on shutdown so a fresh /reload activate re-wires.
  // Without this the guard above short-circuits re-wiring and the extension stays dead after reload
  // (globalThis persists across the module re-evaluation).
  pi.on("session_shutdown", () => {
    g[WIRED_KEY] = false;
  });
}
