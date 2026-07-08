// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isAskUserQuestionResult, lastAssistantText } from "../src/autocatch-hooks.js";

function ctxWithBranch(branch: unknown[]): ExtensionContext {
  return { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
}

describe("isAskUserQuestionResult", () => {
  it("true for a CustomToolResultEvent with toolName 'ask_user_question'", () => {
    expect(isAskUserQuestionResult({ type: "tool_result", toolName: "ask_user_question", details: {} })).toBe(true);
  });

  it("false for tool_result with a different toolName", () => {
    expect(isAskUserQuestionResult({ type: "tool_result", toolName: "read" })).toBe(false);
  });

  it("false for non-tool_result events", () => {
    expect(isAskUserQuestionResult({ type: "tool_call", toolName: "ask_user_question" })).toBe(false);
    expect(isAskUserQuestionResult({ type: "input", text: "hi" })).toBe(false);
  });

  it("false for null/non-object", () => {
    expect(isAskUserQuestionResult(null)).toBe(false);
    expect(isAskUserQuestionResult(undefined)).toBe(false);
    expect(isAskUserQuestionResult("string")).toBe(false);
  });
});

describe("lastAssistantText", () => {
  // getBranch returns entries LEAF→ROOT (index 0 = most recent). SessionMessageEntry
  // shape: { type: "message", message: { role, content, timestamp }, id, parentId, timestamp }.
  function msgEntry(role: string, content: unknown[]): unknown {
    return {
      type: "message",
      message: { role, content, timestamp: Date.now() },
      id: `${role}-${Math.random()}`,
      parentId: null,
      timestamp: new Date().toISOString(),
    };
  }
  function textBlock(text: string): unknown {
    return { type: "text", text };
  }
  function thinkingBlock(text: string): unknown {
    return { type: "thinking", text };
  }
  function toolCallBlock(): unknown {
    return { type: "tool_call", id: "tc1", name: "read", input: {} };
  }

  it("walks leaf→root and returns the most-recent assistant message's text", () => {
    // Leaf-first: [user, assistant("A or B?"), user]. Most recent assistant = "A or B?".
    const branch = [
      msgEntry("user", [textBlock("earlier user")]),
      msgEntry("assistant", [textBlock("A or B?")]),
      msgEntry("user", [textBlock("A")]),
    ];
    expect(lastAssistantText(ctxWithBranch(branch))).toBe("A or B?");
  });

  it("joins multiple text blocks within one assistant message", () => {
    const branch = [
      msgEntry("assistant", [textBlock("part one"), textBlock("part two")]),
      msgEntry("user", [textBlock("reply")]),
    ];
    expect(lastAssistantText(ctxWithBranch(branch))).toBe("part one\npart two");
  });

  it("skips thinking + tool_call blocks, returns only text", () => {
    const branch = [
      msgEntry("assistant", [thinkingBlock("internal"), toolCallBlock(), textBlock("visible answer")]),
      msgEntry("user", [textBlock("reply")]),
    ];
    expect(lastAssistantText(ctxWithBranch(branch))).toBe("visible answer");
  });

  it("returns null when there is no assistant message in the branch", () => {
    const branch = [msgEntry("user", [textBlock("just user")])];
    expect(lastAssistantText(ctxWithBranch(branch))).toBeNull();
  });

  it("with multiple assistant messages returns the MOST RECENT (regression —)", () => {
    // Branch order is oldest→newest (root→leaf): the LATEST assistant is the most recent.
    // lastAssistantText walks newest→oldest and must return the newest assistant text,
    // not the first/oldest one.
    const branch = [
      msgEntry("assistant", [textBlock("oldest assistant")]),
      msgEntry("user", [textBlock("reply 1")]),
      msgEntry("assistant", [textBlock("newest assistant")]),
      msgEntry("user", [textBlock("reply 2")]),
    ];
    expect(lastAssistantText(ctxWithBranch(branch))).toBe("newest assistant");
  });

  it("returns null when the most-recent assistant message has no text blocks (only tool calls)", () => {
    const branch = [msgEntry("assistant", [toolCallBlock()]), msgEntry("user", [textBlock("reply")])];
    expect(lastAssistantText(ctxWithBranch(branch))).toBeNull();
  });

  it("skips non-message entries (compaction, model changes) and finds the assistant message", () => {
    const branch = [
      {
        type: "compaction",
        summary: "...",
        firstKeptEntryId: "x",
        tokensBefore: 100,
        timestamp: new Date().toISOString(),
        id: "c1",
        parentId: null,
      },
      msgEntry("assistant", [textBlock("post-compaction assistant")]),
      msgEntry("user", [textBlock("reply")]),
    ];
    expect(lastAssistantText(ctxWithBranch(branch))).toBe("post-compaction assistant");
  });

  it("returns null for an empty branch", () => {
    expect(lastAssistantText(ctxWithBranch([]))).toBeNull();
  });
});
