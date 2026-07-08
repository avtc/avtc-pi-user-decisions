// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * User Decisions settings schema (10 fields), rendered via the `/user-decisions:settings` command.
 *
 * All validation/normalization is owned by avtc-pi-settings-ui's schema + type system — there is
 * no bespoke config validation in this extension. Enum fields (string type with presets) are
 * membership-checked at load; out-of-bounds numbers and invalid durations fall back to default
 * and are logged via avtc-pi-logger (inside settings-ui). The `model` type resolves its preset
 * list from the registry at modal-open; the `thinking-level` type ships its six built-in levels.
 */

import { type SettingsSchema, settingsFilePaths } from "avtc-pi-settings-ui";

/** Env var name for cross-process settings propagation (subagent cascade + reload survival). */
export const DECISIONS_SETTINGS_ENV_VAR = "PI_SETTINGS_USER_DECISIONS";

/** Full settings schema in avtc-pi-settings-ui format. */
export const DECISIONS_SCHEMA: SettingsSchema = {
  settings: [
    // ── General tab ────────────────────────────────────────────────────────────
    {
      id: "captureMode",
      label: "Capture mode",
      description:
        'How decisions are captured. "agent": the agent records decisions during the conversation using its own judgment. "background": decisions are captured automatically from the conversation by a background LLM, with no agent action. "none": extension disabled.',
      type: "string",
      defaultValue: "agent",
      presets: [
        ["Agent", "agent"],
        ["Background", "background"],
        ["Off", "none"],
      ],
    },
    {
      id: "rankingEnabled",
      label: "Ranking enabled",
      description:
        "When enabled, decisions are ranked by value — the model evaluates each decision's importance and keeps the most valuable at the top. When disabled, decisions are sorted by recency (newest first). All decisions stay reachable via the list tool; this only affects which top decisions are injected into the system prompt up to the limit.",
      type: "boolean",
      defaultValue: true,
    },
    {
      id: "injectIntoSystemPromptEnabled",
      label: "Inject into system prompt",
      description: "Inject user-decisions into the system prompt on subagent session start and on after compaction.",
      type: "boolean",
      defaultValue: true,
    },
    {
      id: "limit",
      label: "Decision limit",
      description:
        "When ranked: the active-store bound (top decisions kept). When not ranked: the most-recent count injected (storage stays unbounded).",
      type: "number",
      min: 1,
      defaultValue: 100,
    },
    // ── Background mode tab ────────────────────────────────────────────────────
    {
      id: "backgroundCaptureModel",
      label: "Capture model",
      description: "Model used for the background auto-catch of user-decisions.",
      type: "model",
      defaultValue: null,
    },
    {
      id: "backgroundRetries",
      label: "Retries",
      description:
        "How many times to retry a failed background capture before asking whether to keep retrying or pause.",
      type: "number",
      min: 0,
      defaultValue: 3,
    },
    {
      id: "backgroundThinkingLevel",
      label: "Thinking level",
      description: "Thinking level for auto-catch user-decisions.",
      type: "thinking-level",
      defaultValue: "low",
    },
    {
      id: "backgroundMaxTokens",
      label: "Max tokens",
      description: "Maximum output tokens per background capture LLM call.",
      type: "number",
      min: 1,
      defaultValue: 8192,
    },
    {
      id: "backgroundCallTimeoutMs",
      label: "Per-call timeout",
      description: "Aborts a background capture LLM call if it runs longer than this.",
      type: "duration",
      min: 1,
      defaultValue: 180_000,
    },
    {
      id: "backgroundCaptureDumpLimit",
      label: "Capture dump limit",
      description: "Maximum debug dump files kept under <cwd>/.pi/user-decisions/debug/ (oldest pruned).",
      type: "number",
      min: 1,
      defaultValue: 30,
    },
  ],
  tabs: [
    {
      label: "General",
      settingIds: ["captureMode", "rankingEnabled", "injectIntoSystemPromptEnabled", "limit"],
    },
    {
      label: "Background mode",
      settingIds: [
        "backgroundCaptureModel",
        "backgroundRetries",
        "backgroundThinkingLevel",
        "backgroundMaxTokens",
        "backgroundCallTimeoutMs",
        "backgroundCaptureDumpLimit",
      ],
    },
  ],
  ...settingsFilePaths("avtc-pi-user-decisions"),
};
