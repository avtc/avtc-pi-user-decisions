// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_PAUSE, PauseSignal, readPauseState, setPaused, writePauseState } from "../src/pause-state.js";

describe("pause-state", () => {
  let dir: string;
  let activePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-pause-"));
    activePath = path.join(dir, "sess.jsonl");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("statePath is a sibling of the active jsonl (.state.json)", () => {
    writePauseState(activePath, { paused: true, pausedAt: "t", pausedBy: 7 });
    expect(fs.existsSync(path.join(dir, "sess.state.json"))).toBe(true);
  });

  it("writePauseState + readPauseState round-trips", () => {
    writePauseState(activePath, { paused: true, pausedAt: "2026-06-23T00:00:00Z", pausedBy: 123 });
    const st = readPauseState(activePath);
    expect(st).toEqual({ paused: true, pausedAt: "2026-06-23T00:00:00Z", pausedBy: 123 });
  });

  it("missing file → EMPTY_PAUSE (no throw)", () => {
    expect(readPauseState(activePath)).toEqual(EMPTY_PAUSE);
  });

  it("corrupt file → EMPTY_PAUSE (no throw)", () => {
    fs.writeFileSync(path.join(dir, "sess.state.json"), "{ not json");
    expect(readPauseState(activePath)).toEqual(EMPTY_PAUSE);
  });

  it("setPaused(true) writes paused + pausedAt + pausedBy; setPaused(false) resets to empty", () => {
    setPaused(activePath, true, 42);
    const on = readPauseState(activePath);
    expect(on.paused).toBe(true);
    expect(on.pausedBy).toBe(42);
    expect(on.pausedAt).not.toBeNull();
    setPaused(activePath, false, 0);
    expect(readPauseState(activePath)).toEqual(EMPTY_PAUSE);
  });

  it("atomic write: no.tmp file left after writePauseState; final file is valid JSON", () => {
    writePauseState(activePath, { paused: true, pausedAt: "t", pausedBy: 1 });
    expect(fs.existsSync(path.join(dir, "sess.state.json.tmp"))).toBe(false);
    expect(() => JSON.parse(fs.readFileSync(path.join(dir, "sess.state.json"), "utf-8"))).not.toThrow();
  });

  it("PauseSignal is an Error subclass (thrown by callWithRetry, caught by the drain)", () => {
    const s = new PauseSignal("paused");
    expect(s).toBeInstanceOf(Error);
    expect(s.message).toBe("paused");
  });
});
