// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc-pi-user-decisions <tarasenkov@gmail.com>

import { afterEach, describe, expect, it } from "vitest";
import { contributeExtraTools } from "../src/subagent.js";

const EXTRA = "PI_SUBAGENT_TOOLS_ADD";

const ALL_TOOLS = ["user_decision_add", "user_decision_list", "user_decision_detail"];
const READ_TOOLS = ["user_decision_list", "user_decision_detail"]; // background mode (read-only)

describe("contributeExtraTools (append-with-dedup)", () => {
  const saved: string | undefined = process.env[EXTRA];

  // Read the current value as a non-undefined string (each test sets it before asserting).
  const getExtra = (): string => process.env[EXTRA] ?? "";

  afterEach(() => {
    // Restore — never leak env mutations between tests.
    if (saved === undefined) delete process.env[EXTRA];
    else process.env[EXTRA] = saved;
  });

  it("agent mode (includeAdd=true), fresh env → sets the 3 decision tools (add+list+detail)", () => {
    delete process.env[EXTRA];
    contributeExtraTools(true);
    expect(getExtra().split(",")).toEqual(ALL_TOOLS);
  });

  it("background mode (includeAdd=false), fresh env → sets list+detail ONLY (no user_decision_add)", () => {
    delete process.env[EXTRA];
    contributeExtraTools(false);
    expect(getExtra().split(",")).toEqual(READ_TOOLS);
    expect(getExtra().split(",")).not.toContain("user_decision_add");
  });

  it("existing value 'read,write' → appends decision tools without dropping read/write, deduped", () => {
    process.env[EXTRA] = "read,write";
    contributeExtraTools(true);
    expect(getExtra().split(",")).toEqual(["read", "write", ...ALL_TOOLS]);
  });

  it("idempotent: calling again with decision tools already present → no duplicates", () => {
    process.env[EXTRA] = "read,write";
    contributeExtraTools(true);
    const afterFirst = getExtra();
    contributeExtraTools(true); // again
    expect(getExtra()).toBe(afterFirst); // same string, no duplicates
    const tools = getExtra().split(",");
    expect(tools).toEqual([...new Set(tools)]); // no dups
  });

  it("commutative: another contributor set 'todo_init,todo_add' first → decision tools appended, todo preserved", () => {
    process.env[EXTRA] = "todo_init,todo_add";
    contributeExtraTools(true);
    expect(getExtra().split(",")).toEqual(["todo_init", "todo_add", ...ALL_TOOLS]);
  });

  it("handles messy whitespace in existing value (' read, write ')", () => {
    process.env[EXTRA] = " read , write ";
    contributeExtraTools(true);
    expect(
      getExtra()
        .split(",")
        .map((s) => s.trim()),
    ).toEqual(["read", "write", ...ALL_TOOLS]);
  });

  it("empty-string existing value is treated like unset", () => {
    process.env[EXTRA] = "";
    contributeExtraTools(true);
    expect(getExtra().split(",")).toEqual(ALL_TOOLS); // no leading empty element
  });

  it("mode downgrade: add present from a prior agent-mode contribute, then background contribute → no removal (append-only union)", () => {
    // A prior agent-mode session contributed user_decision_add. A later background-mode session running
    // in the same process contributes only read tools. The union keeps user_decision_add (append-only:
    // contributors never REMOVE — the subagent's own tool registration decides what to expose).
    process.env[EXTRA] = "user_decision_add";
    contributeExtraTools(false);
    const tools = getExtra().split(",");
    expect(tools).toEqual(expect.arrayContaining(["user_decision_add", "user_decision_list", "user_decision_detail"]));
  });
});
