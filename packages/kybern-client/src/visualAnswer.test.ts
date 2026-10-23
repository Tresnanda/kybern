import { expect, test } from "bun:test";
import { answerAction, answerRowText, answerHint, answerKind, answerOptions, answerReceipt, answerTitle, draftLabel, visualAnswerInput } from "./visualAnswer.ts";
import type { ApprovalRequest } from "./types.ts";

const layout = { type: "object", properties: { layout: { enum: ["A", "B", "C"] } }, required: ["layout"] };

test("the schema decides the kind and the options", () => {
  expect(answerKind(layout)).toBe("choice");
  expect(answerKind({ enum: ["yes", "no"] })).toBe("choice");
  expect(answerKind({ type: "object", properties: { max: { type: "number" }, quality: { type: "number" } } })).toBe("settings");
  expect(answerKind({ type: "object", properties: { note: { type: "string" } } })).toBe("answer");
  expect(answerKind(null)).toBe("choice");
  expect(answerOptions(layout)).toEqual(["A", "B", "C"]);
  expect(answerOptions({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } } })).toEqual([]);
});

test("the bar's words follow the draft", () => {
  expect(answerTitle("choice", "Claude")).toBe("Claude is waiting for your choice");
  expect(answerHint("choice", null)).toBe("Choose above, then send it.");
  expect(answerHint("choice", "Layout B")).toBe("Layout B selected. Press ↵ to send it.");
  expect(answerAction("choice", "Layout B")).toBe("Send layout B");
  expect(answerAction("choice", "Layout B · Side panel")).toBe("Send layout B");
  expect(answerRowText("Pick a layout", null)).toBe("Waiting for your choice in “Pick a layout”");
  expect(answerRowText("Pick a layout", { decision: "submit", response: { reply: "B" } })).toBe("Answered “Pick a layout” in words");
  expect(answerRowText("Pick a layout", { decision: "deny" })).toBe("Skipped “Pick a layout”");
  expect(answerAction("settings", "2 changes")).toBe("Apply 2 changes");
  expect(draftLabel({ layout: "B" })).toBe("B");
  expect(draftLabel({ max: 30, quality: 62 })).toBe("2 values");
  expect(draftLabel("B", " Side panel ")).toBe("Side panel");
});

test("receipts name what happened", () => {
  const at = "2026-10-23T00:00:00Z";
  expect(answerReceipt({ status: "answered", answer: { layout: "B" }, label: "Layout B · Side panel", at }, "choice", "Claude")).toBe("You chose Layout B · Side panel");
  expect(answerReceipt({ status: "answered", answer: { max: 30 }, label: "30 MB max", at }, "settings", "Claude")).toBe("You applied: 30 MB max");
  expect(answerReceipt({ status: "replied", at }, "choice", "Claude")).toBe("You replied instead");
  expect(answerReceipt({ status: "timed_out", at }, "choice", "Codex")).toBe("Timed out, Codex went on without it");
});

test("only the visual answer card is read", () => {
  const card = (tool_name: string, input: unknown) => ({ id: "a", thread_id: "t", turn_id: "u", tool_name, input, summary: "", suggestions: [], created_at: "" }) as unknown as ApprovalRequest;
  expect(visualAnswerInput(card("kybern_visual_answer", { visual_id: "v", title: "Pick", schema: layout }))).toEqual({ visual_id: "v", title: "Pick", schema: layout });
  expect(visualAnswerInput(card("kybern_request_secret", { visual_id: "v", title: "Pick" }))).toBeNull();
  expect(visualAnswerInput(card("kybern_visual_answer", { title: "Pick" }))).toBeNull();
});
