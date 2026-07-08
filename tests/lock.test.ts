// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireUnderLock, cleanupOnExit, makeLockState } from "../src/lock.js";

function tmpLockDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-adapter-"));
  return path.join(dir, "session.lock.sqlite");
}

describe("acquireUnderLock — runs fn under the mutex", () => {
  it("runs fn and returns its result; state.held is true during fn, false after", async () => {
    const st = makeLockState();
    const lock = tmpLockDb();
    let seenHeld = false;
    const result = await acquireUnderLock(st, lock, () => {
      seenHeld = st.held;
      return 42;
    });
    expect(result).toBe(42);
    expect(seenHeld).toBe(true);
    expect(st.held).toBe(false); // released after fn
  });

  it("supports an async fn", async () => {
    const st = makeLockState();
    const lock = tmpLockDb();
    const result = await acquireUnderLock(st, lock, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "done";
    });
    expect(result).toBe("done");
  });
});

describe("acquireUnderLock — mutual exclusion (two concurrent runs serialize)", () => {
  it("two acquireUnderLock on the same path run fn bodies serially (no overlap)", async () => {
    const lock = tmpLockDb();
    const log: string[] = [];
    let inFn = false;

    const run = async (tag: string) => {
      const st = makeLockState();
      await acquireUnderLock(st, lock, async () => {
        if (inFn) log.push(`${tag}: OVERLAP!`); // would indicate two holders at once
        inFn = true;
        log.push(`${tag}: start`);
        await new Promise((r) => setTimeout(r, 40));
        log.push(`${tag}: end`);
        inFn = false;
      });
    };

    await Promise.all([run("A"), run("B")]);
    expect(log.some((l) => l.includes("OVERLAP"))).toBe(false); // never two holders
    // each start is followed by its own end before the other starts
    const starts = log.filter((l) => l.endsWith(": start")).map((l) => l.split(":")[0]);
    const ends = log.filter((l) => l.endsWith(": end")).map((l) => l.split(":")[0]);
    expect(starts).toEqual(ends); // both ran
    expect(log.indexOf("A: start") < log.indexOf("A: end")).toBe(true);
    expect(log.indexOf("B: start") < log.indexOf("B: end")).toBe(true);
  });
});

describe("acquireUnderLock — abort / failure returns null (never throws)", () => {
  it("a blocked acquire returns null when state.abort fires", async () => {
    const holder = makeLockState();
    const waiter = makeLockState();
    const lock = tmpLockDb();
    // holder takes the lock and holds it
    const release = acquireUnderLock(holder, lock, async () => {
      await new Promise((r) => setTimeout(r, 150));
      return "held";
    });
    // give the holder a moment to acquire
    await new Promise((r) => setTimeout(r, 15));
    // waiter sets its AbortController BEFORE acquireUnderLock (the signal is captured at
    // acquire time — mirrors autocatch setting deps.lockState.abort before runCapture).
    const ac = new AbortController();
    waiter.abort = ac;
    const waiterP = acquireUnderLock(waiter, lock, () => "should-not-run");
    // waiter is blocked in the busy-retry loop; abort it mid-wait
    await new Promise((r) => setTimeout(r, 25));
    ac.abort();
    const res = await waiterP;
    expect(res).toBeNull(); // aborted → null, fn never ran
    expect(waiter.held).toBe(false);
    await release; // let the holder finish (tidy)
  });

  it("returns null (never throws) if the mutex acquire fails", async () => {
    const st = makeLockState();
    // An invalid path (directory as lock db) makes open fail → acquireUnderLock returns null
    const bad = path.join(os.tmpdir(), "nonexistent-dir-xyz", "x.lock.sqlite");
    const res = await acquireUnderLock(st, bad, () => "should-not-run");
    expect(res).toBeNull();
    expect(st.held).toBe(false);
  });
});

describe("acquireUnderLock — fn that throws still releases the lock", () => {
  it("a throwing fn propagates after releasing (lock is free for the next acquire)", async () => {
    const lock = tmpLockDb();
    const st = makeLockState();
    await expect(
      acquireUnderLock(st, lock, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(st.held).toBe(false);
    // lock is usable again
    const st2 = makeLockState();
    const r = await acquireUnderLock(st2, lock, () => "ok");
    expect(r).toBe("ok");
  });
});

describe("cleanupOnExit (process.exit + session_shutdown teardown)", () => {
  it("cleanupOnExit on a never-held state is a no-op (no throw)", () => {
    const st = makeLockState();
    expect(() => cleanupOnExit(st)).not.toThrow();
  });

  it("cleanupOnExit aborts an in-flight AbortController + releases a held mutex", async () => {
    const st = makeLockState();
    const lock = tmpLockDb();
    const ac = new AbortController();
    st.abort = ac;
    // hold the lock via acquireUnderLock, then teardown mid-hold
    const holdP = acquireUnderLock(st, lock, async () => {
      await new Promise((r) => setTimeout(r, 100));
      return "held";
    });
    await new Promise((r) => setTimeout(r, 15)); // let it acquire
    expect(st.held).toBe(true);
    cleanupOnExit(st);
    expect(ac.signal.aborted).toBe(true);
    expect(st.abort).toBeNull();
    await holdP; // fn completes; finally releases (idempotent)
  });
});
