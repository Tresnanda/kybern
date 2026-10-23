// Visuals that ask (`kybern_html_publish` with `await_answer`): reading the waiting card, the words of the
// answer bar and its receipt. Both clients use these so the copy cannot drift.
import { VISUAL_ANSWER_TOOL, type ApprovalRequest, type JsonValue, type VisualAnswerInput, type VisualAnswerRecord } from "./types.ts";

/** The waiting card's input, or null for any other approval. */
export function visualAnswerInput(approval: ApprovalRequest | null | undefined): VisualAnswerInput | null {
  if (!approval || approval.tool_name !== VISUAL_ANSWER_TOOL) return null;
  const input = approval.input as Record<string, unknown> | null;
  if (!input || typeof input.visual_id !== "string" || typeof input.title !== "string") return null;
  return { visual_id: input.visual_id, title: input.title, schema: (input.schema ?? null) as JsonValue | null };
}

/** `choice`: one value from a list. `settings`: several values to tune. `answer`: anything else. */
export type AnswerKind = "choice" | "settings" | "answer";
export function answerKind(schema: JsonValue | null | undefined): AnswerKind {
  const s = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, JsonValue> : null;
  if (!s) return "choice";
  if (Array.isArray(s.enum) || Array.isArray(s.oneOf)) return "choice";
  const properties = s.properties && typeof s.properties === "object" && !Array.isArray(s.properties) ? Object.values(s.properties) : [];
  if (properties.length === 1) {
    const only = properties[0] as Record<string, JsonValue> | null;
    return only && (Array.isArray(only.enum) || Array.isArray(only.oneOf)) ? "choice" : "answer";
  }
  return properties.length > 1 ? "settings" : "answer";
}

/** The options of an `enum` answer, in order: digits 1–9 pick them. */
export function answerOptions(schema: JsonValue | null | undefined): JsonValue[] {
  const s = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, JsonValue> : null;
  if (!s) return [];
  if (Array.isArray(s.enum)) return s.enum;
  const properties = s.properties && typeof s.properties === "object" && !Array.isArray(s.properties) ? Object.values(s.properties) : [];
  const only = properties.length === 1 ? properties[0] as Record<string, JsonValue> | null : null;
  return only && Array.isArray(only.enum) ? only.enum : [];
}

const WAITING: Record<AnswerKind, string> = { choice: "your choice", settings: "your settings", answer: "your answer" };
/** "Claude is waiting for your choice". */
export function answerTitle(kind: AnswerKind, agent: string): string {
  return `${agent} is waiting for ${WAITING[kind]}`;
}
/** The hint before anything is drafted, and once something is. */
export function answerHint(kind: AnswerKind, label: string | null): string {
  if (label) return `${label} selected. Press ↵ to send it.`;
  return kind === "settings" ? "Adjust the settings above, then apply them." : kind === "choice" ? "Choose above, then send it." : "Answer above, then send it.";
}
/** The primary button: verb plus value ("Send layout B", "Apply changes"). */
export function answerAction(kind: AnswerKind, label: string | null): string {
  // The button names the value only: "Layout B · Side panel" sends as "Send layout B".
  const value = label?.split(" · ")[0]?.trim() || null;
  if (kind === "settings") return value ? `Apply ${value}` : "Apply changes";
  if (!value) return "Send";
  return `Send ${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}
/** The work row for the waiting card, and once it is settled. */
export function answerRowText(title: string, decision: { decision: string; response?: unknown } | null): string {
  if (!decision) return `Waiting for your choice in “${title}”`;
  if (decision.decision === "deny") return `Skipped “${title}”`;
  const response = decision.response as Record<string, unknown> | undefined;
  return response && typeof response.reply === "string" ? `Answered “${title}” in words` : `Answered “${title}”`;
}
/** What the value is called when the page gave no label. */
export function draftLabel(value: JsonValue, label?: string | null): string {
  if (label && label.trim()) return label.trim();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.values(value);
    if (entries.length === 1 && ["string", "number", "boolean"].includes(typeof entries[0])) return String(entries[0]);
    return `${entries.length} values`;
  }
  return "your answer";
}
export const ANSWER_COPY = {
  skip: "Skip",
  sending: "Sending…",
  sendError: "Unable to send your choice. Check the connection and send again.",
  placeholder: "Or reply in your own words",
  show: "Show",
  stubHint: "Choose in the visual, or type a reply below to answer in words.",
} as const;
/** The stub above the composer while the visual is out of view. */
export function answerStubTitle(kind: AnswerKind, agent: string, title: string): string {
  return `${answerTitle(kind, agent)} in “${title}”`;
}
/** The one-line record under an answered visual. */
export function answerReceipt(record: VisualAnswerRecord, kind: AnswerKind, agent: string): string {
  switch (record.status) {
    case "answered": {
      const label = record.label || (record.answer !== undefined && record.answer !== null ? draftLabel(record.answer) : "an answer");
      return kind === "settings" ? `You applied: ${label}` : `You chose ${label}`;
    }
    case "replied": return "You replied instead";
    case "skipped": return "Skipped";
    case "cancelled": return "The turn ended before an answer";
    case "timed_out": return `Timed out, ${agent} went on without it`;
  }
}
/** A choice made after the agent stopped waiting goes as an ordinary message. */
export function lateAnswerMessage(title: string, label: string): string {
  return `I chose ${label} in “${title}”.`;
}
