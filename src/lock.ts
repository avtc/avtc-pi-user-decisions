// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { acquireSqliteMutex, type SqliteMutex } from "./snippets/vendored/sqlite-mutex.js";

/**
 * Cross-process lock — `node:sqlite` mutex adapter.
 *
 * The lock is a `BEGIN IMMEDIATE` mutex on a `<sessionId>.lock.sqlite` sentinel DB (the
 * vendored snippet). Crash auto-releases via hot-journal rollback — no heartbeat, no
 * staleness, no PID check, no reclaim (the file-lock model's irreducible reclaim race is
 * gone by construction). See src/snippets/vendored/sqlite-mutex.ts +.
 *
 * Read-modify-write atomicity (load-bearing): `acquireUnderLock` runs `fn`
 * while the mutex is held; `fn` MUST read the store fresh (not reuse a copy read outside
 * the lock), or two agents superseding the same rule from stale cached copies overwrite
 * each other (lost update).
 */
export interface LockState {
  held: boolean;
  abort: AbortController | null; // signals in-flight builder LLM / a blocked acquire to stop on session_shutdown
  mutex: SqliteMutex | null; // the held SQLite mutex (null when not held)
  lockDbPath: string | null;
}

export function makeLockState(): LockState {
  return { held: false, abort: null, mutex: null, lockDbPath: null };
}

/**
 * Run `fn` under the cross-process mutex. Blocks (busy-retry) until acquired or
 * `state.abort` fires (returns null on abort/failure — caller surfaces a tool error or
 * skips). `fn` must read the store FRESH (read-modify-write atomicity).
 * Never throws — returns null if the lock could not be acquired.
 */
export async function acquireUnderLock<T>(
  state: LockState,
  lockDbPath: string,
  fn: () => Promise<T> | T,
): Promise<T | null> {
  state.lockDbPath = lockDbPath;
  let mutex: SqliteMutex;
  try {
    mutex = await acquireSqliteMutex(lockDbPath, state.abort?.signal ?? null);
  } catch {
    return null; // aborted or failed to acquire — caller surfaces the error
  }
  state.mutex = mutex;
  state.held = true;
  try {
    return await fn();
  } finally {
    mutex.release();
    state.mutex = null;
    state.held = false;
  }
}

/**
 * process.on("exit") / session_shutdown teardown: abort in-flight builder work + release
 * the mutex if held (ROLLBACK + close). Safe to call even if no lock was ever acquired
 * . SQLite also auto-releases on process exit regardless (hot-journal rollback).
 */
export function cleanupOnExit(state: LockState): void {
  if (state.abort) {
    state.abort.abort();
    state.abort = null;
  }
  if (state.mutex) {
    state.mutex.release();
    state.mutex = null;
  }
  state.held = false;
}
