// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Global test setup, registered via `setupFiles` in vitest.config.ts.
 *
 * The suite runs with `isolate: false` for speed, which shares ONE module
 * registry and ONE `globalThis` across every test file (the sibling-repo
 * convention — avtc-pi-portrait / avtc-pi-session-owl). This file owns the
 * cross-file invariant that makes safe: every temp dir handed out through
 * tests/temp-dir.ts's `tempDir()` is removed when its test FILE ends — the
 * sweep rides an afterAll here so an individual suite never needs its own
 * teardown for plain temp dirs (and cannot forget one).
 */

import { afterAll } from "vitest";
import { sweepTempDirs } from "./temp-dir.js";

// Every tempDir() handed out in the file — see tests/temp-dir.ts.
afterAll(() => {
  sweepTempDirs();
});
