// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** Read-only decision tools (available in agent AND background modes). */
const READ_TOOL_NAMES = ["user_decision_list", "user_decision_detail"] as const;

/** The write tool (agent mode only — background delegates all writes to the pipeline). */
const ADD_TOOL_NAME = "user_decision_add" as const;

/** Internal: all decision tool names (agent mode contributes the full set). */
const ALL_TOOL_NAMES = [ADD_TOOL_NAME, ...READ_TOOL_NAMES] as const;

/**
 * Append-with-dedup decision tool names into PI_SUBAGENT_TOOLS_ADD (Repo 2).
 * Commutative across extension load order (multiple contributors union without clobbering).
 * Read-modify-write on the env var; auto-cascades to spawned subagents via the PI_ prefix
 * (avtc-pi-subagent env.ts auto-cascades all PI_*).
 *
 * `includeAdd` selects the set per captureMode:
 *  - agent mode → add + list + detail (the agent writes via user_decision_add)
 *  - background mode → list + detail only (the pipeline owns all writes; the agent is read-only)
 */
export function contributeExtraTools(includeAdd: boolean): void {
  const names = includeAdd ? ALL_TOOL_NAMES : READ_TOOL_NAMES;
  const current = process.env.PI_SUBAGENT_TOOLS_ADD;
  const existing = current
    ? current
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  const merged = [...new Set([...existing, ...names])];
  process.env.PI_SUBAGENT_TOOLS_ADD = merged.join(",");
}
