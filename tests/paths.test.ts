// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dataDir,
  isRootSession,
  lockDbPath,
  resolveActivePath,
  sessionsDir,
  siblingPath,
  tierPaths,
} from "../src/paths.js";

const PARENT_PID = "PI_SUBAGENT_PARENT_PID";
const SESSION_FILE = "PI_DECISIONS_SESSION_FILE";

describe("paths", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of [PARENT_PID, SESSION_FILE]) {
      if (k in saved) {
        process.env[k] = saved[k] as string;
        delete saved[k];
      } else {
        delete process.env[k];
      }
    }
  });

  function stash(keys: string[]): void {
    for (const k of keys) {
      saved[k] = process.env[k];
    }
  }

  it("sessionsDir is <cwd>/.pi/user-decisions/sessions", () => {
    expect(sessionsDir("/repo")).toBe(path.join("/repo", ".pi", "user-decisions", "sessions"));
  });

  it("dataDir is <cwd>/.pi/user-decisions", () => {
    expect(dataDir("/repo")).toBe(path.join("/repo", ".pi", "user-decisions"));
  });

  it("tierPaths ranked: active + evicted + dropped siblings", () => {
    const tp = tierPaths("/r/.pi/user-decisions/sessions/abc.jsonl", true);
    expect(tp.active).toBe("/r/.pi/user-decisions/sessions/abc.jsonl");
    expect(tp.evicted).toBe("/r/.pi/user-decisions/sessions/abc.evicted.jsonl");
    expect(tp.dropped).toBe("/r/.pi/user-decisions/sessions/abc.dropped.jsonl");
  });

  it("tierPaths not-ranked: evicted is null", () => {
    const tp = tierPaths("/r/.pi/user-decisions/sessions/abc.jsonl", false);
    expect(tp.active).toBe("/r/.pi/user-decisions/sessions/abc.jsonl");
    expect(tp.evicted).toBeNull();
    expect(tp.dropped).toBe("/r/.pi/user-decisions/sessions/abc.dropped.jsonl");
  });

  it("lockDbPath sits next to active jsonl (.lock.sqlite)", () => {
    expect(lockDbPath("/r/.pi/user-decisions/sessions/abc.jsonl")).toBe(
      "/r/.pi/user-decisions/sessions/abc.lock.sqlite",
    );
  });

  it("siblingPath : swaps the.jsonl suffix for the given one", () => {
    const active = "/r/.pi/user-decisions/sessions/abc.jsonl";
    expect(siblingPath(active, "dropped.jsonl")).toBe("/r/.pi/user-decisions/sessions/abc.dropped.jsonl");
    expect(siblingPath(active, "state.json")).toBe("/r/.pi/user-decisions/sessions/abc.state.json");
  });

  it("siblingPath : missing.jsonl suffix → appends loudly (no silent tier aliasing)", () => {
    // A malformed active path (no.jsonl) must NOT silently return the same path (which would alias
    // dropped===active and corrupt the store). It appends the suffix so the misconfiguration is loud.
    expect(siblingPath("/r/bad-path", "dropped.jsonl")).toBe("/r/bad-path.dropped.jsonl");
  });

  it("isRootSession flips on PI_SUBAGENT_PARENT_PID", () => {
    stash([PARENT_PID]);
    delete process.env[PARENT_PID];
    expect(isRootSession()).toBe(true);
    process.env[PARENT_PID] = "12345";
    expect(isRootSession()).toBe(false);
  });

  it("resolveActivePath — root computes from sessionId", () => {
    stash([PARENT_PID, SESSION_FILE]);
    delete process.env[PARENT_PID];
    delete process.env[SESSION_FILE];
    expect(resolveActivePath("/repo", "sess-1")).toBe(
      path.join("/repo", ".pi", "user-decisions", "sessions", "sess-1.jsonl"),
    );
  });

  it("resolveActivePath — subagent reads env verbatim, ignores own sessionId", () => {
    stash([PARENT_PID, SESSION_FILE]);
    process.env[PARENT_PID] = "12345";
    process.env[SESSION_FILE] = "/repo/.pi/user-decisions/sessions/PARENT.jsonl";
    // subagent's own sessionId differs but must NOT be used
    expect(resolveActivePath("/repo", "child-different")).toBe("/repo/.pi/user-decisions/sessions/PARENT.jsonl");
  });

  it("resolveActivePath — subagent without env var returns null (degraded)", () => {
    stash([PARENT_PID, SESSION_FILE]);
    process.env[PARENT_PID] = "12345";
    delete process.env[SESSION_FILE];
    expect(resolveActivePath("/repo", "child")).toBeNull();
  });
});
