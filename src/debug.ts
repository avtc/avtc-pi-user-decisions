// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Debug dump helpers for the background-capture pipeline.
 *
 * Mirrors avtc-pi-portrait/src/debug.ts: always-on (not env-gated), one timestamped file per
 * capture under `<cwd>/.pi/user-decisions/debug/`, pruned to the last N (`captureDumpLimit`).
 * Each file records what the extractor/builder SAW and PRODUCED (full prompts + responses)
 * the "what agent sees and what it produces" trace. Writes are synchronous (appendFileSync) so
 * output is flushed to disk immediately — nothing is lost if the process dies mid-generation.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DEBUG_DIR_NAME = "debug";

/** Monotonic counter for same-millisecond dump ordering (deterministic prune order).
 * Zero-padded so filename sort = creation order within a process. */
let dumpCounter = 0;

/** Ensure <parentDir>/debug exists and return its path. */
function ensureDebugDir(parentDir: string): string {
  const dir = path.join(parentDir, DEBUG_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a new timestamped debug dump file `<prefix>-<timestamp>-<nonce>.txt` in the debug dir,
 * prune older files with the same prefix to keep at most `limit`, and return the new path.
 * The file is not created here — the first appendDebug call creates it. The random suffix avoids
 * same-millisecond overwrites in a tight loop (toISOString has ms resolution).
 *
 * Pruning sorts by FILENAME, not mtime: the ISO timestamp in the name sorts lexicographically
 * (= creation order) and avoids N per-file `statSync` calls on the capture path. mtime is wrong for
 * dump rotation anyway — `appendDebug` bumps mtime on each write, so a first-created dump still being
 * appended would look newer than a later-created one and escape pruning.
 */
export function openDebugDump(parentDir: string, prefix: string, limit: number): string {
  const dir = ensureDebugDir(parentDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Filename = <prefix>-<isoTs>-<paddedCounter>-<nonce>.txt:
  //  - isoTs: ms-resolution, human-readable, primary chronological sort key
  //  - paddedCounter: process-monotonic, zero-padded → deterministic order for same-ms files
  //    (fixes the same-millisecond tie: pruning sorts by filename, and a bare random nonce made
  //    the oldest pick non-deterministic in a tight loop)
  //  - nonce: short random → cross-process/restart collision safety
  const seq = dumpCounter++;
  const nonce = Math.random().toString(16).slice(2, 8);
  const dumpPath = path.join(dir, `${prefix}-${timestamp}-${seq.toString().padStart(6, "0")}-${nonce}.txt`);
  // Prune oldest first by FILENAME (creation order — see the doc above). The padded counter
  // breaks same-ms ties deterministically. One readdir, no per-file statSync on the capture path.
  const existing = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".txt"))
    .sort();
  while (existing.length >= limit) {
    const oldest = existing.shift();
    if (!oldest) break;
    try {
      fs.unlinkSync(path.join(dir, oldest));
    } catch {
      /* best-effort */
    }
  }
  return dumpPath;
}

/** Append content to a debug dump file (synchronously flushed). Never throws. */
export function appendDebug(dumpPath: string, content: string): void {
  try {
    fs.appendFileSync(dumpPath, content);
  } catch {
    // best-effort — logging must not break the pipeline
  }
}
