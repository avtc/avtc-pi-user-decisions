// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LockState } from "../src/lock.js";
import { cleanupOnExit, makeLockState } from "../src/lock.js";
import { writeTier } from "../src/storage.js";
import { registerDecisionTools, type ToolRuntime } from "../src/tools.js";
import type { DecisionRecord, TierPaths } from "../src/types.js";

/** Decision storage: ranked mode */
const RANKED_MODE = true;

/** Decision storage: unranked mode */
const UNRANKED_MODE = false;

let dir: string;
let lockState: LockState;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-tools-"));
  lockState = makeLockState();
});
afterEach(() => {
  cleanupOnExit(lockState);
  fs.rmSync(dir, { recursive: true, force: true });
});

function rec(id: number, opts: Partial<DecisionRecord> | null): DecisionRecord {
  return {
    id,
    scope: "session",
    supersedes: null,
    timestamp: new Date(Date.now() - (100 - id) * 1000).toISOString(),
    summary: `decision ${id}`,
    detail: `detail ${id}`,
    ...(opts ?? {}),
  };
}

/** No decision record options (use defaults) */
const NO_DECISION_OPTS: Partial<DecisionRecord> | null = null;

/** Mock pi that collects registered tools; execute is callable for tests. renderers
 * (renderCall/renderResult) are captured too so the TUI rendering path is testable. */
interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
  renderCall?: (args: Record<string, unknown>, theme: FakeTheme) => unknown;
  renderResult?: (result: unknown, options: { expanded?: boolean }, theme: FakeTheme) => unknown;
}

/** A fake Theme that returns the composed string unchanged (so assertions are on the text). */
class FakeTheme {
  fg(_key: string, s: string) {
    return s;
  }
  bold(s: string) {
    return s;
  }
}

function mockPi(): { pi: ExtensionAPI; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(t: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      execute: RegisteredTool["execute"];
      renderCall?: RegisteredTool["renderCall"];
      renderResult?: RegisteredTool["renderResult"];
    }) {
      tools.push({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        execute: t.execute,
        renderCall: t.renderCall,
        renderResult: t.renderResult,
      });
    },
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

function runtime(ranked: boolean): ToolRuntime {
  const active = path.join(dir, "s1.jsonl");
  const tp: TierPaths = {
    active,
    evicted: ranked ? path.join(dir, "s1.evicted.jsonl") : null,
    dropped: path.join(dir, "s1.dropped.jsonl"),
  };
  return {
    config: {
      captureMode: "agent",
      backgroundCaptureModel: null,
      rankingEnabled: ranked,
      injectIntoSystemPromptEnabled: true,
      limit: 20,
      backgroundRetries: 0,
      backgroundThinkingLevel: "low" as const,
      backgroundMaxTokens: 8192,
      backgroundCallTimeoutMs: 30_000,
      backgroundCaptureDumpLimit: 30,
    },
    tiers: tp,
    lockState,
    lockFilePath: path.join(dir, "s1.lock.sqlite"),
  };
}

function seedActive(rt: ToolRuntime, records: DecisionRecord[]): void {
  writeTier(rt.tiers.active, records);
}

/** Ranked runtimes always have an evicted path — guard it so biome doesn't flag non-null assertions. */
function evictedOf(rt: ToolRuntime): string {
  if (!rt.tiers.evicted) throw new Error("ranked runtime must have an evicted path");
  return rt.tiers.evicted;
}

describe("registerDecisionTools — config-aware schemas + descriptions", () => {
  it("ranked: user_decision_add registers beforeId whose param desc contains 'value-ordered'", () => {
    const { pi, tools } = mockPi();
    registerDecisionTools(pi, () => runtime(RANKED_MODE), { allowAdd: true });
    const add = tools.find((t) => t.name === "user_decision_add");
    expect(add).toBeDefined();
    const props = (add?.parameters as { properties?: Record<string, { description?: string }> })?.properties;
    expect(props?.beforeId).toBeDefined();
    expect(props?.beforeId?.description).toContain("value-ordered");
  });

  it("not-ranked: user_decision_add schema OMITS beforeId; listDesc contains 'most-recent'", () => {
    const { pi, tools } = mockPi();
    registerDecisionTools(pi, () => runtime(UNRANKED_MODE), { allowAdd: true });
    const add = tools.find((t) => t.name === "user_decision_add");
    const props = (add?.parameters as { properties?: Record<string, unknown> })?.properties;
    expect(props?.beforeId).toBeUndefined();
    const list = tools.find((t) => t.name === "user_decision_list");
    expect(list?.description).toContain("most-recent");
    expect(list?.description).not.toContain("value-ordered");
  });

  it("approved description strings are present verbatim", () => {
    const { pi, tools } = mockPi();
    registerDecisionTools(pi, () => runtime(RANKED_MODE), { allowAdd: true });
    const add = tools.find((t) => t.name === "user_decision_add");
    expect(add?.description).toBe(
      "Persist a user decision. It survives compaction and is propagated to subagents. A decision can supersede earlier decisions.",
    );
    const detail = tools.find((t) => t.name === "user_decision_detail");
    expect(detail?.description).toBe("Recall a user decision's details by id.");
  });
});

describe("user_decision_add handler", () => {
  it("ranked add inserts at top; returns {id, summary, superseded}", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    seedActive(rt, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS)]);
    const add = tools.find((t) => t.name === "user_decision_add");
    const result = (await add?.execute("id", { summary: "new", detail: "d" })) as {
      content: { text: string }[];
      details: { id: number; summary: string; superseded: number[]; displayText: string };
    };
    expect(result.details.id).toBe(3);
    expect(result.details.summary).toBe("new");
    expect(result.details.superseded).toEqual([]);
    // : content = "{Id} {Summary}" (plain id, no #); detail is in displayText only (user-expanded).
    expect(result.content[0].text).toBe("3 new");
    expect(result.details.displayText).toContain("3 new");
    expect(result.details.displayText).toContain("d"); // detail in displayText (expanded render)
    expect(result.content[0].text).not.toContain("d"); // detail NOT echoed to the model
  });

  it("getRuntime returns null → isError result (no throw)", async () => {
    const { pi, tools } = mockPi();
    registerDecisionTools(pi, () => null, { allowAdd: true });
    const add = tools.find((t) => t.name === "user_decision_add");
    const result = (await add?.execute("id", { summary: "x" })) as {
      content: { text: string }[];
      details: { error?: string };
    };
    expect(result.details.error).toBeDefined();
  });

  it("ranked add threads beforeId (positioning) + supersedes (→ dropped) + model-facing Supersede content", async () => {
    // Exercises the handler's typeof/Array.isArray coercion branches + write-threading + the
    // model-visible "Supersede:" content line through the tool boundary (not just applyAdd directly).
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    seedActive(rt, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS), rec(3, NO_DECISION_OPTS)]);
    const add = tools.find((t) => t.name === "user_decision_add");
    const result = (await add?.execute("id", {
      summary: "replacement",
      detail: "d",
      beforeId: 2, // insert before id 2 (positioning branch)
      supersedes: [1, 3], // supersede branch → ids 1 + 3 move to dropped
    })) as {
      content: { text: string }[];
      details: { id: number; summary: string; superseded: number[] };
    };
    expect(result.details.id).toBe(4);
    expect(result.details.superseded).toEqual([1, 3]);
    // Model-facing content includes the Supersede line (not just the id/summary).
    expect(result.content[0].text).toContain("4 replacement");
    expect(result.content[0].text).toContain("Supersede: 1,3");
    // The superseded records moved to the dropped tier.
    const dropped = fs.readFileSync(rt.tiers.dropped, "utf-8");
    expect(dropped).toContain('"id":1');
    expect(dropped).toContain('"id":3');
    // The new record is positioned before id 2 in the active tier.
    const active = fs.readFileSync(rt.tiers.active, "utf-8").trim().split("\n");
    const ids = active.map((line) => JSON.parse(line).id);
    expect(ids.indexOf(4)).toBeLessThan(ids.indexOf(2));
  });

  it("not-ranked add ignores beforeId at the handler level (no positioning in append mode)", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(UNRANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    seedActive(rt, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS)]);
    const add = tools.find((t) => t.name === "user_decision_add");
    const result = (await add?.execute("id", {
      summary: "appended",
      detail: "d",
      beforeId: 1, // ignored in not-ranked mode — appends to the end
    })) as { details: { id: number } };
    expect(result.details.id).toBe(3);
    // Not-ranked: new record is at the tail (file order), not before id 1.
    const active = fs.readFileSync(rt.tiers.active, "utf-8").trim().split("\n");
    expect(active.at(-1)).toContain('"id":3');
  });
});

describe("user_decision_list handler", () => {
  it("default status returns live (active+evicted) excluding dropped; content = the ordered list (no count line,)", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    seedActive(rt, [rec(1, NO_DECISION_OPTS), rec(2, NO_DECISION_OPTS)]);
    writeTier(evictedOf(rt), [rec(3, NO_DECISION_OPTS)]);
    writeTier(rt.tiers.dropped, [rec(4, NO_DECISION_OPTS)]);
    const list = tools.find((t) => t.name === "user_decision_list");
    const result = (await list?.execute("id", {})) as {
      content: { text: string }[];
      details: { rows: { id: number; status: string }[] };
    };
    const ids = result.details.rows.map((r) => r.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3); // evicted is "live"
    expect(ids).not.toContain(4); // dropped excluded
    // : content is the ordered list (ids+summaries), NOT a count line.
    expect(result.content[0].text).not.toMatch(/^\d+ decision\(s\)\.$/);
    expect(result.content[0].text).toContain("1 decision 1");
    expect(result.content[0].text).toContain("2 decision 2");
  });

  it("empty store → content '(no decisions)' (R2-20d — clear UX signal, not blank)", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    // no tiers seeded
    const list = tools.find((t) => t.name === "user_decision_list");
    const result = (await list?.execute("id", {})) as {
      content: { text: string }[];
      details: { rows: unknown[] };
    };
    expect(result.content[0].text).toBe("(no decisions)");
    expect(result.details.rows).toEqual([]);
  });

  it("status=dropped returns only dropped", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    seedActive(rt, [rec(1, NO_DECISION_OPTS)]);
    writeTier(rt.tiers.dropped, [rec(2, NO_DECISION_OPTS), rec(3, NO_DECISION_OPTS)]);
    const list = tools.find((t) => t.name === "user_decision_list");
    const result = (await list?.execute("id", { status: "dropped" })) as {
      details: { rows: { id: number }[] };
    };
    expect(result.details.rows.map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it("filter substring matches summary+detail (case-insensitive)", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    seedActive(rt, [
      rec(1, { summary: "Use postgres", detail: "for prod" }),
      rec(2, { summary: "Use sqlite", detail: "for tests" }),
    ]);
    const list = tools.find((t) => t.name === "user_decision_list");
    const result = (await list?.execute("id", { filter: "POSTGRES" })) as {
      details: { rows: { id: number }[] };
    };
    expect(result.details.rows.map((r) => r.id)).toEqual([1]);
  });
});

describe("user_decision_detail handler", () => {
  it("always returns the full record (— full param dropped); content = id/summary/timestamp/detail", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    seedActive(rt, [rec(1, { detail: "the full detail" })]);
    const detail = tools.find((t) => t.name === "user_decision_detail");
    const result = (await detail?.execute("id", { id: 1 })) as {
      content: { text: string }[];
      details: { id: number; detail: string; summary: string; status: string; displayText: string };
    };
    expect(result.details.id).toBe(1);
    expect(result.details.detail).toBe("the full detail");
    // content is the full record (no full param needed)
    expect(result.content[0].text).toContain("1 decision 1");
    expect(result.content[0].text).toContain("the full detail");
  });

  it("returns full record incl supersededBy (always,)", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    // record 2 supersedes record 1
    writeTier(rt.tiers.active, [rec(2, { supersedes: [1] })]);
    writeTier(rt.tiers.dropped, [rec(1, NO_DECISION_OPTS)]);
    const detailTool = tools.find((t) => t.name === "user_decision_detail");
    const result = (await detailTool?.execute("id", { id: 1 })) as {
      details: { id: number; status: string; supersededBy: number[] };
    };
    expect(result.details.id).toBe(1);
    expect(result.details.status).toBe("dropped");
    expect(result.details.supersededBy).toEqual([2]);
  });

  it("unknown id → error result (no throw)", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    const detailTool = tools.find((t) => t.name === "user_decision_detail");
    const result = (await detailTool?.execute("id", { id: 999 })) as {
      details: { error?: string };
    };
    expect(result.details.error).toBeDefined();
  });
});

// --- TUI rendering (renderCall + renderResult) — coverage for the per-tool renderers. ---
// The model-visible content lives in content[0].text; displayText mirrors it for the TUI.
// Collapsed truncates to COLLAPSED_LINE_LIMIT (12) + '(Ctrl+O to expand)'; expanded shows full.
// user_decision_add collapsed must NOT include detail (user-only in expanded).
// The renderers return a pi-tui Text component — render(width) returns padded string[]; join +
// assert with toContain so padding doesn't interfere.
function renderStr(t: unknown): string {
  return ((t as { render(w: number): string[] }).render(80) ?? []).join("\n");
}

describe("renderCall / renderResult", () => {
  const theme = new FakeTheme();

  it("user_decision_add renderCall formats the title with the summary", () => {
    const { pi, tools } = mockPi();
    registerDecisionTools(pi, () => runtime(RANKED_MODE), { allowAdd: true });
    const add = tools.find((t) => t.name === "user_decision_add");
    expect(renderStr(add?.renderCall?.({ summary: "use jsonl" }, theme))).toContain("user_decision_add");
    expect(renderStr(add?.renderCall?.({ summary: "use jsonl" }, theme))).toContain('"use jsonl"');
  });

  it("user_decision_list renderCall formats the title with the filter", () => {
    const { pi, tools } = mockPi();
    registerDecisionTools(pi, () => runtime(RANKED_MODE), { allowAdd: true });
    const list = tools.find((t) => t.name === "user_decision_list");
    expect(renderStr(list?.renderCall?.({ filter: "jsonl" }, theme))).toContain("user_decision_list");
    expect(renderStr(list?.renderCall?.({ filter: "jsonl" }, theme))).toContain("[jsonl]");
  });

  it("user_decision_detail renderCall formats the title with the id", () => {
    const { pi, tools } = mockPi();
    registerDecisionTools(pi, () => runtime(RANKED_MODE), { allowAdd: true });
    const detail = tools.find((t) => t.name === "user_decision_detail");
    expect(renderStr(detail?.renderCall?.({ id: 7 }, theme))).toContain("user_decision_detail");
    expect(renderStr(detail?.renderCall?.({ id: 7 }, theme))).toContain("7");
  });

  it("user_decision_add collapsed content has NO detail (user-only in expanded)", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    const add = tools.find((t) => t.name === "user_decision_add");
    const result = await add?.execute("id", { summary: "the decision", detail: "SECRET detail" });
    const collapsed = renderStr(add?.renderResult?.(result, {}, theme));
    expect(collapsed).toContain("the decision");
    expect(collapsed).not.toContain("SECRET detail"); // detail is USER-ONLY in expanded
  });

  it("user_decision_add expanded shows the full displayText (incl detail)", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    const add = tools.find((t) => t.name === "user_decision_add");
    const result = await add?.execute("id", { summary: "the decision", detail: "SECRET detail" });
    const expanded = renderStr(add?.renderResult?.(result, { expanded: true }, theme));
    expect(expanded).toContain("SECRET detail");
  });

  it("error branch renders the error text (red)", async () => {
    const { pi, tools } = mockPi();
    const rt = runtime(RANKED_MODE);
    registerDecisionTools(pi, () => rt, { allowAdd: true });
    const detail = tools.find((t) => t.name === "user_decision_detail");
    const errResult = (await detail?.execute("id", { id: 999 })) as { details: { error: string } }; // unknown id
    const rendered = renderStr(detail?.renderResult?.(errResult, {}, theme));
    expect(rendered).toContain(errResult.details.error); // FakeTheme passes error text through
  });

  it("collapsed truncates over COLLAPSED_LINE_LIMIT + adds (Ctrl+O to expand)", () => {
    const { pi, tools } = mockPi();
    registerDecisionTools(pi, () => runtime(RANKED_MODE), { allowAdd: true });
    const list = tools.find((t) => t.name === "user_decision_list");
    // 20 records → renderListContent produces 20 lines (> 12 → truncated)
    const big = {
      details: {
        displayText: Array.from({ length: 20 }, (_, i) => `${i + 1} line ${i + 1}`).join("\n"),
      },
    };
    expect(renderStr(list?.renderResult?.(big, {}, theme))).toContain("(Ctrl+O to expand)");
    const expanded = renderStr(list?.renderResult?.(big, { expanded: true }, theme));
    expect(expanded).not.toContain("(Ctrl+O to expand)");
    expect(expanded).toContain("20 line 20"); // full content in expanded
  });
});
