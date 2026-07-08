// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendDebug, openDebugDump } from "../src/debug.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-debug-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("openDebugDump", () => {
  it("returns a path under <parent>/debug/ with the prefix", () => {
    const p = openDebugDump(dir, "capture", 5);
    expect(p.startsWith(path.join(dir, "debug"))).toBe(true);
    expect(path.basename(p).startsWith("capture-")).toBe(true);
    expect(p.endsWith(".txt")).toBe(true);
  });

  it("creates the debug dir if missing", () => {
    expect(fs.existsSync(path.join(dir, "debug"))).toBe(false);
    openDebugDump(dir, "capture", 5);
    expect(fs.existsSync(path.join(dir, "debug"))).toBe(true);
  });

  it("prunes oldest files beyond the limit (keeps exactly `limit`, oldest-first)", () => {
    for (let i = 0; i < 6; i++) {
      const p = openDebugDump(dir, "capture", 3);
      appendDebug(p, `dump ${i}`); // create the file (openDebugDump itself doesn't create it)
    }
    const files = fs.readdirSync(path.join(dir, "debug")).filter((f) => f.startsWith("capture-"));
    // Exactly 3 retained (NOT 0/1/2 — a strict toBe catches over-pruning regressions)
    expect(files.length).toBe(3);
    // Oldest (dump 0/1/2) pruned, newest (dump 3/4/5) kept
    const contents = files.map((f) => fs.readFileSync(path.join(dir, "debug", f), "utf8")).sort();
    expect(contents).toEqual(["dump 3", "dump 4", "dump 5"]);
  });

  it("does not touch files with a different prefix", () => {
    const a = openDebugDump(dir, "capture", 1);
    appendDebug(a, "a");
    const b = openDebugDump(dir, "extract", 1);
    appendDebug(b, "b");
    const files = fs.readdirSync(path.join(dir, "debug"));
    expect(files.some((f) => f.startsWith("capture-"))).toBe(true);
    expect(files.some((f) => f.startsWith("extract-"))).toBe(true);
  });
});

describe("appendDebug", () => {
  it("appends content to the file (creating it)", () => {
    const p = openDebugDump(dir, "capture", 5);
    appendDebug(p, "hello\n");
    appendDebug(p, "world\n");
    expect(fs.readFileSync(p, "utf8")).toBe("hello\nworld\n");
  });

  it("never throws on a bad path (best-effort)", () => {
    expect(() => appendDebug(path.join(dir, "does-not-exist", "x.txt"), "x")).not.toThrow();
  });
});
