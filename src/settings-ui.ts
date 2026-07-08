// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The single, canonical user-decisions settings handle.
 *
 * Registered once here (rather than in `index.ts`) so every module reads settings through the
 * same accessor. {@link initDecisionsSettings} is called from the extension's activate function
 * (where `pi` is available); until then the handle is `undefined`, which is fine because all reads
 * happen at runtime (after activate). Callers read {@link getDecisionsSettings}; no consumer
 * re-parses or re-normalizes the env var.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsCommand, type SettingsHandle } from "avtc-pi-settings-ui";
import { DECISIONS_SCHEMA, DECISIONS_SETTINGS_ENV_VAR } from "./schema.js";
import type { DecisionsConfig } from "./types.js";

let handle: SettingsHandle<DecisionsConfig> | undefined;

/**
 * Test-only override for the settings read (DI/mock pattern): when set, {@link getDecisionsSettings}
 * returns this instead of the real handle. Set up in tests before the SUT runs; cleared by
 * {@link _resetGetDecisionsSettings}.
 */
let _getSettingsOverride: (() => DecisionsConfig) | null = null;

/** Test-only: inject a mock settings source (pass `null` to restore the real handle). */
export function _setGetDecisionsSettings(fn: (() => DecisionsConfig) | null): void {
  _getSettingsOverride = fn;
}

/** Test-only: clear the mock override (restore real-handle reads). */
export function _resetGetDecisionsSettings(): void {
  _getSettingsOverride = null;
}

/**
 * Register the /user-decisions:settings command + modal and create the settings handle.
 * Must be called from the extension's activate function (needs `pi`). Loads settings immediately
 * (registration time) and on every session_start.
 */
export function initDecisionsSettings(pi: ExtensionAPI): void {
  handle = registerSettingsCommand<DecisionsConfig>(pi, DECISIONS_SCHEMA, {
    commandName: "user-decisions:settings",
    title: "User Decisions Settings",
    titleRight: "avtc-pi-user-decisions",
    envVar: DECISIONS_SETTINGS_ENV_VAR,
  });
}

/** Read the current user-decisions settings (normalized by the schema). */
export function getDecisionsSettings(): DecisionsConfig {
  if (_getSettingsOverride) return _getSettingsOverride();
  if (!handle) throw new Error("user-decisions settings not initialized — initDecisionsSettings not called");
  return handle.getSettings();
}
