// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Root user-decisions logger.
 *
 * Thin wrapper over the shared `avtc-pi-logger` library. The implementation (file backend,
 * rotation, retention, level formatting) lives in the library; this module only owns the
 * user-decisions singleton.
 *
 * Logs land at `~/.pi/logs/avtc-pi-user-decisions/<YYYY-MM-DD>.log` (date-partitioned, with size
 * roll-over + age-based retention — all handled by the library). Best-effort: a logging failure
 * never throws to the host.
 *
 * Operational flow logging for background mode (`captureMode: "background"`): capture enqueue /
 * drain, extract + build phase boundaries, LLM attempt + result (with token progress), retry, and
 * pause/resume. The intent is to make an "infinite model invocation without progress in finished
 * items or tokens" failure fully traceable from the log alone.
 *
 * Per-module scoped loggers are derived via `log.child("<module>")` in each module (capture /
 * extract / build / llm), so every log line is tagged with its origin without a second sink.
 */

import { createLogger } from "avtc-pi-logger";

/** No custom logger options — use library defaults. */
const NO_LOGGER_OPTIONS: Parameters<typeof createLogger>[1] = null;

/** Root user-decisions logger — writes to ~/.pi/logs/avtc-pi-user-decisions/<date>.log (best-effort). */
export const log = createLogger("avtc-pi-user-decisions", NO_LOGGER_OPTIONS);
