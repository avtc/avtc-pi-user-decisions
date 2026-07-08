// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import { siblingPath } from "./paths.js";

/** Pause state persisted next to the jsonl tiers + lock. */
export interface PauseState {
  paused: boolean;
  pausedAt: string | null;
  pausedBy: number | null;
}

export const EMPTY_PAUSE: PauseState = { paused: false, pausedAt: null, pausedBy: null };

/** Boolean flag for setPaused: pause vs resume (no-bare-literals convention). */
export const PAUSED = true;
export const RESUMED = false;

/**
 * Pause sentinel — thrown by callWithRetry (autocatch.ts) when the user chooses "Pause" in the
 * exhaustion dialog (or via /user-decisions:pause). Caught by the drain (index.ts): the drain
 * stops processing but leaves the queue intact (captures still enqueue — no loss).
 */
export class PauseSignal extends Error {}

/** The pause-state file is a sibling of the active jsonl (state.json) via the shared helper. */
function statePath(activePath: string): string {
  return siblingPath(activePath, "state.json");
}

/** Read pause state. Missing/corrupt file → EMPTY_PAUSE (atomic tmp+rename means no torn reads). */
export function readPauseState(activePath: string): PauseState {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(activePath), "utf-8")) as Partial<PauseState>;
    return {
      paused: raw.paused === true,
      pausedAt: typeof raw.pausedAt === "string" ? raw.pausedAt : null,
      pausedBy: typeof raw.pausedBy === "number" ? raw.pausedBy : null,
    };
  } catch {
    return { ...EMPTY_PAUSE };
  }
}

/** Atomically write pause state (tmp+rename — single writer = root). */
export function writePauseState(activePath: string, st: PauseState): void {
  const p = statePath(activePath);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st), "utf-8");
  fs.renameSync(tmp, p);
}

/** Set or clear pause state. `activePath` is the session's active jsonl path. */
export function setPaused(activePath: string, paused: boolean, pid: number): void {
  if (paused) {
    writePauseState(activePath, { paused: true, pausedAt: new Date().toISOString(), pausedBy: pid });
  } else {
    writePauseState(activePath, { ...EMPTY_PAUSE });
  }
}

/** Async sleep with backoff (used by callWithRetry's exponential backoff). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}
