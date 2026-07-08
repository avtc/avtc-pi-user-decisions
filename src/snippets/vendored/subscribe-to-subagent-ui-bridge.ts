// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * UI Bridge forwarding — shared infrastructure for subagent-ui-bridge integration.
 *
 * Copy this file into your extension's src/snippets/vendored/ directory, then:
 *   1. Define your root-side handler (renders the dialog when a subagent requests it)
 *   2. Call subscribeToUiBridge(pi, contentType, rootHandler) in your extension entry point
 *   3. Call forwardToRoot({ contentType, payload, text }) for child-side forwarding
 *
 * Root-side: registers a handler via pi.events that renders dialogs from subagents.
 * Child-side: forwards requests to root session via sendAndWait.
 *
 * If pi-subagent-ui-bridge is not installed, all functions are no-ops.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

/** Message metadata forwarded with subagent requests (mirrors pi-subagent-ui-bridge's MessageMeta). */
export interface MessageMeta {
  agentName?: string;
  lastMessage?: string;
  sessionFile?: string;
}

/** Options passed to sendAndWait for forwarding a request to the root session. */
export interface ForwardToRootOptions {
  contentType: string;
  payload: Record<string, unknown>;
  text: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Reply from the root session after forwarding. */
export interface ForwardedReply {
  payload: unknown;
}

/** The root-side handler signature — renders the dialog and returns a result.
 *  Generic over the ctx shape each consumer needs (defaults to unknown) so this
 *  vendored file needs no cross-package SDK import; consumers pin TCtx locally. */
export type RootHandler<TCtx = unknown, TPayload = unknown> = (input: {
  ctx: TCtx;
  clientId: string;
  contentType: string;
  /** Type-level only — payload crosses IPC as opaque JSON. Validate at runtime if untrusted. */
  payload: TPayload;
  meta: MessageMeta;
}) => Promise<unknown>;

// ── Module state ─────────────────────────────────────────────────────────────

/**
 * Shared VALUE, stored on globalThis so it survives jiti `moduleCache: false` re-imports
 * (which create distinct module instances and would otherwise split a module-level
 * `let` between the setter in subscribeToUiBridge() and the getter in forwardToRoot()).
 *
 * `sendAndWait` is idempotent across subscribers — there is one root bridge, so one
 * function. Listener unsubs are NOT shared: each subscribeToUiBridge() call owns its
 * own local closure unsubs.
 */
interface UiBridgeForwardingState {
  sendAndWait: ((options: ForwardToRootOptions) => Promise<ForwardedReply>) | null;
}
const STATE_KEY = "__piSubagentUiBridgeForwarding";
type GlobalWithState = typeof globalThis & { [STATE_KEY]?: UiBridgeForwardingState };
function _state(): UiBridgeForwardingState {
  const g = globalThis as GlobalWithState;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = { sendAndWait: null };
  }
  const state = g[STATE_KEY];
  return state;
}

/**
 * Reset module state — called during test cleanup.
 */
export function _resetUiBridgeState(): void {
  _state().sendAndWait = null;
}

/**
 * Subscribe to pi-subagent-ui-bridge:ready event emitted by pi-subagent-ui-bridge.
 * Call once per extension entry point.
 *
 * @param pi - The pi extension API
 * @param contentType - The content type this extension handles (e.g. "ask_user_question")
 * @param rootHandler - Async function that renders the dialog and returns a result
 *
 * Reload-safe: session_shutdown fires before reload, cleaning all listeners.
 */
export function subscribeToUiBridge<TCtx, TPayload>(
  pi: ExtensionAPI,
  contentType: string,
  rootHandler: RootHandler<TCtx, TPayload>,
): void {
  if (!pi.events) return; // graceful no-op for incomplete test mocks

  const unsubs: Array<() => void> = [];

  // Listen for pi-subagent-ui-bridge:ready (emitted by pi-subagent-ui-bridge in session_start)
  unsubs.push(
    pi.events.on("pi-subagent-ui-bridge:ready", (data: unknown) => {
      const api = data as {
        registerHandler?: (contentType: string, handler: RootHandler<TCtx, TPayload>) => void;
        sendAndWait?: (options: ForwardToRootOptions) => Promise<ForwardedReply>;
      };

      if (typeof api.registerHandler === "function") {
        api.registerHandler(contentType, rootHandler);
      }
      if (typeof api.sendAndWait === "function") {
        _state().sendAndWait = api.sendAndWait;
      }
    }),
  );

  // Reset on session shutdown (fires before reload) — clean ONLY this subscriber's
  // EventBus listener (pi.on listeners are torn down by pi), then clear shared value
  // (hygiene; provider re-emits on next session_start).
  pi.on("session_shutdown", () => {
    for (const unsub of unsubs) {
      if (typeof unsub === "function") unsub();
    }
    unsubs.length = 0;
    _state().sendAndWait = null;
  });
}

/**
 * Check if subagent bridge forwarding is available.
 * Returns true only when in a subagent context with an active bridge.
 */
export function isSubagentBridgeAvailable(): boolean {
  return !!process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET && _state().sendAndWait !== null;
}

/**
 * Forward a request to the root session via the subagent-ui-bridge.
 * Returns null if not in a subagent context or the bridge is not ready.
 *
 * @param options - The forwarding options (contentType, payload, text, signal, timeoutMs)
 * @returns The reply from the root session, or null if forwarding is unavailable
 */
export async function forwardToRoot(options: ForwardToRootOptions): Promise<ForwardedReply | null> {
  if (!process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET) return null;

  // Temporal coupling: env var is set at session_start by pi-subagent-ui-bridge,
  // and the pi-subagent-ui-bridge:ready event fires during session_start before
  // any tool calls. If this is called before the event fires, sendAndWait is null.
  const sendAndWait = _state().sendAndWait;
  if (!sendAndWait) return null;

  return sendAndWait(options);
}
