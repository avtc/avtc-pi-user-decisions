// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ModelThinkingLevel } from "@earendil-works/pi-ai/compat";

export type { ModelThinkingLevel } from "@earendil-works/pi-ai/compat";

/** A stored decision record (same shape across all tiers). */
export interface DecisionRecord {
  id: number; // sequential int, assigned under lock
  scope: "session"; // v1: session only
  supersedes: number[] | null; // present only on a replacement record (ids moved to dropped); else null
  timestamp: string; // ISO 8601
  summary: string;
  detail: string;
}

/** Per-record status is DERIVED at read time = which file the record is in. */
export type DecisionStatus = "active" | "evicted" | "dropped";

export type CaptureMode = "none" | "agent" | "background";

export interface DecisionsConfig {
  captureMode: CaptureMode;
  backgroundCaptureModel: string | null; // "provider/id" | null (null = session model); inert unless captureMode === "background"
  rankingEnabled: boolean;
  injectIntoSystemPromptEnabled: boolean; // gate the injection path only (modulates agent/background; "none" injects nothing)
  limit: number;
  backgroundRetries: number; // background-pipeline LLM retry attempts per phase before the continue/pause dialog
  // LLM call params (mirror portrait config — prevent hangs on slow/misbehaving local LLMs)
  backgroundThinkingLevel: ModelThinkingLevel; // reasoning depth for auto-catch LLM calls ("off" = no reasoning)
  backgroundMaxTokens: number; // max output tokens per auto-catch LLM call
  backgroundCallTimeoutMs: number; // per-call timeout in ms that aborts the call if it hangs
  backgroundCaptureDumpLimit: number; // max extract/build debug dump files kept under <cwd>/.pi/user-decisions/debug/
}

/** Which tier files exist for the active ranking mode. */
export interface TierPaths {
  active: string;
  evicted: string | null; // null when rankingEnabled === false
  dropped: string;
}
