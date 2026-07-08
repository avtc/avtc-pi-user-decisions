// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyAdd, formatRecordLine } from "./decisions.js";
import { acquireUnderLock, type LockState } from "./lock.js";
import { queryDetail, queryList } from "./render.js";
import type { DecisionsConfig, TierPaths } from "./types.js";

// Approved agent-facing strings. Ordering phrase is config-aware.
const DECISION_ADD_DESC =
  "Persist a user decision. It survives compaction and is propagated to subagents. A decision can supersede earlier decisions.";
const SUMMARY_DESC =
  "One line summary describing user decision or behavioural correction (if missing in system prompt). Add only ones that affects continuation of this session. It will be injected into system prompt after session compaction and for subagents, and available via user_decision_list result.";
const DETAIL_DESC = "Extra details, available via user_decision_detail by id";
const SUPERSEDES_DESC = "Ids of earlier decisions this replaces.";
const BEFORE_ID_DESC =
  "Insert before this id. The list is value-ordered (top = most valuable) — place the new decision just above the first one you'd trade away for it. Omit for default position.";
const FILTER_DESC = "Substring match across summary and detail.";
const STATUS_DESC = "live | dropped | all. Omit for current decisions.";
const LIST_LIMIT_DESC = "Maximum number of results.";
const DETAIL_ID_DESC = "Decision id.";
const DETAIL_TOOL_DESC = "Recall a user decision's details by id.";

function listDesc(rankingEnabled: boolean): string {
  return rankingEnabled
    ? "Recall summarized user decisions with a substring filter. Results are value-ordered: most valuable first."
    : "Recall summarized user decisions with a substring filter. Results are most-recent first.";
}

export interface ToolRuntime {
  config: DecisionsConfig;
  tiers: TierPaths; // active paths for the current session (root or subagent)
  lockState: LockState;
  lockFilePath: string;
}

/**
 * Run fn under the cross-process SQLite mutex (acquire → operate → release). `fn` reads
 * the store FRESH inside (read-modify-write atomicity, — never a copy cached
 * outside the lock, or two agents superseding the same rule would overwrite each other).
 * Returns null if the lock could not be acquired (caller surfaces a tool error).
 */
function underLock<T>(rt: ToolRuntime, fn: () => Promise<T> | T): Promise<T | null> {
  return acquireUnderLock(rt.lockState, rt.lockFilePath, fn);
}

function ok(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function errResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: text } };
}

type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };

// --- Content renderers. Plain id format (NO # prefix). ---

/** user_decision_add — content (model sees) = id/summary (+supersede); detail is USER-ONLY in expanded. */
function renderAddContent(rec: { id: number; summary: string; supersedes: number[] | null }): string {
  const lines = [formatRecordLine(rec)];
  if (rec.supersedes && rec.supersedes.length > 0) lines.push(`Supersede: ${rec.supersedes.join(",")}`);
  return lines.join("\n");
}

// --- list/detail content renderers + query helpers live in render.ts (shared with commands.ts). ---

// --- TUI renderers (main-session-direct only; best-effort). ---
const COLLAPSED_LINE_LIMIT = 12;

/** Collapse source for renderResultText — the collapsed (default) view's content origin.
 * DISPLAY = the full displayText (list/detail); CONTENT = the model-visible content (add — detail
 * is user-only in expanded). Named constants (not bare booleans) per the no-bare-literals rule. */
const COLLAPSED_FROM_DISPLAY = false;
const COLLAPSED_FROM_CONTENT = true;

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

/** Render the result Text. `collapsedFromContent` selects the collapsed source:
 *  - COLLAPSED_FROM_DISPLAY (list/detail): the full displayText, truncated when collapsed (default).
 *  - COLLAPSED_FROM_CONTENT (add): the model-visible CONTENT (id/summary, no detail) when collapsed
 * detail is user-only in expanded (the load-bearing rule that the model never sees detail). */
function renderResultText(
  result: { details?: { displayText?: string; error?: string }; content?: { text?: string }[] },
  options: { expanded?: boolean },
  theme: Theme,
  collapsedFromContent: boolean,
): Text {
  if (result.details?.error) return new Text(theme.fg("error", result.details.error), 0, 0);
  const full = result.details?.displayText ?? result.content?.[0]?.text ?? "";
  if (options.expanded) return new Text(theme.fg("text", full), 0, 0);
  const source = collapsedFromContent ? (result.content?.[0]?.text ?? "") : full;
  const { text, truncated } = truncateLines(source, COLLAPSED_LINE_LIMIT);
  return new Text(theme.fg("text", truncated ? `${text}\n(Ctrl+O to expand)` : text), 0, 0);
}

/** Per-tool body: receives the resolved runtime + parsed params, returns the tool result. */
type ExecuteHandler = (rt: ToolRuntime, params: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

/**
 * Build a tool `execute` that resolves the runtime once (shared signature + guard), then
 * delegates to the per-tool handler. Declares the SDK-mandated execute signature ONCE so the
 * three decision tools don't duplicate it (keeps jscpd clean).
 */
function makeExecute(getRuntime: () => ToolRuntime | null, handler: ExecuteHandler) {
  return async (
    _toolCallId: string,
    params: Record<string, unknown>,
    _signal: unknown,
    _onUpdate: unknown,
    _ctx: ExtensionContext,
  ): Promise<ToolResult> => {
    const rt = getRuntime();
    if (!rt) return errResult("decisions not available (no session store)");
    return handler(rt, params);
  };
}

export function registerDecisionTools(
  pi: ExtensionAPI,
  getRuntime: () => ToolRuntime | null,
  opts: { allowAdd: boolean; onAdd?: () => void },
): void {
  // Read rankingEnabled ONCE at registration time to pick the schema/description variant
  // (config-aware; the agent never sees a mode-conditional).
  const rt = getRuntime();
  const ranking = rt ? rt.config.rankingEnabled : true;

  // --- user_decision_add (agent mode only — the write tool; background delegates all writes to the pipeline) ---
  if (opts.allowAdd) {
    const AddParams = ranking
      ? Type.Object({
          summary: Type.String({ description: SUMMARY_DESC }),
          detail: Type.Optional(Type.String({ description: DETAIL_DESC })),
          beforeId: Type.Optional(Type.Number({ description: BEFORE_ID_DESC })),
          supersedes: Type.Optional(Type.Array(Type.Number(), { description: SUPERSEDES_DESC })),
        })
      : Type.Object({
          summary: Type.String({ description: SUMMARY_DESC }),
          detail: Type.Optional(Type.String({ description: DETAIL_DESC })),
          supersedes: Type.Optional(Type.Array(Type.Number(), { description: SUPERSEDES_DESC })),
        });

    pi.registerTool({
      name: "user_decision_add",
      label: "Decision Add",
      description: DECISION_ADD_DESC,
      parameters: AddParams,
      execute: makeExecute(getRuntime, async (rt, params) => {
        const summary = String(params.summary ?? "");
        const detail = params.detail != null ? String(params.detail) : "";
        const beforeId = typeof params.beforeId === "number" ? params.beforeId : null;
        const supersedes = Array.isArray(params.supersedes) ? (params.supersedes as number[]) : null;
        const result = await underLock(rt, () =>
          applyAdd(
            rt.tiers,
            { summary, detail, beforeId, supersedes, rankingEnabled: rt.config.rankingEnabled, limit: rt.config.limit },
            new Date(),
          ),
        );
        if (result === null) return errResult("decisions store busy (lock unavailable)");
        // Notify caller so it can refresh the status bar (in agent mode the poll timer is off).
        opts.onAdd?.();
        const rec = { id: result.id, summary, supersedes: result.superseded.length > 0 ? result.superseded : null };
        // : content = id/summary (+supersede), NO detail echoed to model; displayText adds the
        // detail (user-only in expanded render — do NOT run displayText through the truncation helper).
        const content = renderAddContent(rec);
        const displayText = detail.length > 0 ? `${content}\n${detail}` : content;
        return ok(content, {
          displayText,
          id: rec.id,
          summary: rec.summary,
          supersedes: rec.supersedes,
          superseded: result.superseded,
        });
      }),
      renderCall(args: { summary?: string }, theme: Theme) {
        return new Text(theme.fg("toolTitle", theme.bold(`user_decision_add "${args.summary ?? ""}"`)), 0, 0);
      },
      renderResult(result, options: { expanded?: boolean }, theme: Theme) {
        // user_decision_add: collapsed from CONTENT (no detail — detail is user-only in expanded)
        return renderResultText(
          result as Parameters<typeof renderResultText>[0],
          options,
          theme,
          COLLAPSED_FROM_CONTENT,
        );
      },
    });
  } // end allowAdd (user_decision_add — agent mode only)

  // --- user_decision_list (agent + background — read tool) ---
  pi.registerTool({
    name: "user_decision_list",
    label: "Decision List",
    description: listDesc(ranking),
    parameters: Type.Object({
      filter: Type.Optional(Type.String({ description: FILTER_DESC })),
      status: Type.Optional(
        Type.Union([Type.Literal("live"), Type.Literal("dropped"), Type.Literal("all")], { description: STATUS_DESC }),
      ),
      limit: Type.Optional(Type.Number({ description: LIST_LIMIT_DESC })),
    }),
    execute: makeExecute(getRuntime, (rt, params) => {
      const status = (params.status === "dropped" || params.status === "all" ? params.status : "live") as
        | "live"
        | "dropped"
        | "all";
      const filter = typeof params.filter === "string" ? params.filter : null;
      const limitParam = typeof params.limit === "number" ? params.limit : null;
      // Shared read+filter+order (also used by /user-decisions:list) — one source of truth.
      const { rows, content } = queryList(rt.tiers, rt.config.rankingEnabled, {
        status,
        filter,
        limit: limitParam,
      });
      return ok(content, { displayText: content, rows });
    }),
    renderCall(args: { filter?: string }, theme: Theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("user_decision_list")) +
          (args.filter ? theme.fg("dim", ` [${args.filter}]`) : ""),
        0,
        0,
      );
    },
    renderResult(result, options: { expanded?: boolean }, theme: Theme) {
      return renderResultText(result as Parameters<typeof renderResultText>[0], options, theme, COLLAPSED_FROM_DISPLAY);
    },
  });

  // --- user_decision_detail (agent + background — read tool;: full param DROPPED — always returns the full record) ---
  pi.registerTool({
    name: "user_decision_detail",
    label: "Decision Detail",
    description: DETAIL_TOOL_DESC,
    parameters: Type.Object({
      id: Type.Number({ description: DETAIL_ID_DESC }),
    }),
    execute: makeExecute(getRuntime, (rt, params) => {
      const id = typeof params.id === "number" ? params.id : NaN;
      const res = queryDetail(rt.tiers, id);
      if (!res.found) return errResult(`No decision ${id}.`);
      const { content, rec, supersededBy } = res;
      return ok(content, {
        displayText: content,
        id: rec.id,
        summary: rec.summary,
        detail: rec.detail,
        status: rec.status,
        supersedes: rec.supersedes,
        supersededBy,
        timestamp: rec.timestamp,
      });
    }),
    renderCall(args: { id?: number }, theme: Theme) {
      return new Text(theme.fg("toolTitle", theme.bold(`user_decision_detail ${args.id ?? ""}`)), 0, 0);
    },
    renderResult(result, options: { expanded?: boolean }, theme: Theme) {
      return renderResultText(result as Parameters<typeof renderResultText>[0], options, theme, COLLAPSED_FROM_DISPLAY);
    },
  });
}
