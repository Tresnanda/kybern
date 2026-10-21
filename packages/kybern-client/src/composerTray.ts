// Rules of the composer tray: the one surface above the composer for everything running beside a turn (subagents,
// background tasks, helper threads and queued follow-ups). Pure, so every client words and orders it the same way.
import { agentResultItems, plainLine, structuredMessageSummary, threadMessagePart } from "./delegations.ts";
import { stripLabel, subagentGroupDefaultOpen, type SubagentCounts } from "./subagents.ts";
import type { ContentPart, UserMessage } from "./types.ts";

export interface QueuedPreview {
  /** The line the row shows. Never empty. */
  text: string;
  /** A muted second part after the line: the agents of a result batch, or what else the prompt carries. */
  detail: string | null;
  /** `update` for a message from another thread or a batch of delegated results; `prompt` for the user's own follow-up. */
  kind: "prompt" | "update";
  /** Inline image sources (`data:` URLs) of `image` parts, for thumbnails. */
  images: string[];
  /** Image parts and image attachments, counted together. */
  imageCount: number;
  /** Nothing but images: the row can lead with a thumbnail instead of a glyph. */
  imagesOnly: boolean;
}

const isImageAttachment = (part: ContentPart) => part.type === "attachment" && part.media_type.startsWith("image/");

/** How a non-text part reads inside a one-line preview: `@src/a.ts`, `$review`, `@Notes`, the file name. */
function partLabel(part: ContentPart): string | null {
  switch (part.type) {
    case "file_mention":
      return `@${part.path}`;
    case "skill":
      return `$${part.name}`;
    case "mention":
      return `@${part.display_name ?? part.name}`;
    case "thread_reference":
      return `@${part.title}`;
    case "attachment":
      return part.media_type.startsWith("image/") ? null : part.name;
    default:
      return null;
  }
}

/**
 * One queued follow-up as a row. A message from another thread or a batch of results reads from its parts (`Results from 2
 * agents`); a prompt shows its words. A prompt without words (an image, a file, a skill) still says what it carries instead
 * of a placeholder: `Image`, `2 images`, `$review @src/a.ts`.
 */
export function queuedPreview(message: Pick<UserMessage, "parts">): QueuedPreview {
  const images = message.parts.flatMap((part) => (part.type === "image" ? [`data:${part.media_type};base64,${part.data}`] : []));
  const imageCount = images.length + message.parts.filter(isImageAttachment).length;
  const structured = structuredMessageSummary(message);
  if (structured) {
    const items = agentResultItems(message.parts);
    const inbound = threadMessagePart(message.parts);
    const detail = items ? items.map((item) => item.title).join(", ") : inbound ? plainLine(inbound.body, 200) : null;
    return { text: structured, detail: detail || null, kind: "update", images, imageCount, imagesOnly: false };
  }
  const words = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ").replace(/\s+/g, " ").trim();
  const labels = message.parts.flatMap((part) => partLabel(part) ?? []);
  if (words) return { text: words, detail: null, kind: "prompt", images, imageCount, imagesOnly: false };
  if (labels.length) return { text: labels.join(" "), detail: null, kind: "prompt", images, imageCount, imagesOnly: false };
  if (imageCount) return { text: imageCount === 1 ? "Image" : `${imageCount} images`, detail: null, kind: "prompt", images, imageCount, imagesOnly: true };
  return { text: "Queued follow-up", detail: null, kind: "prompt", images, imageCount, imagesOnly: false };
}

/**
 * The part of a shell command that identifies it. A leading `cd <dir> &&` becomes the folder (`gpuix`), so the row shows
 * the command itself rather than a long path; everything else is kept, the full command stays available as the tooltip.
 */
export function commandSummary(command: string): { text: string; folder: string | null } {
  let text = command.trim();
  let folder: string | null = null;
  for (;;) {
    const cd = text.match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/);
    if (!cd) break;
    const dir = cd[1]!.replace(/^["']|["']$/g, "").replace(/\/+$/, "");
    folder = dir.split("/").filter(Boolean).pop() ?? dir;
    text = text.slice(cd[0].length);
  }
  return { text: text || command.trim(), folder };
}

export interface TrayCounts {
  subagents: SubagentCounts;
  /** Background processes and monitors still running. */
  tasks: number;
  helpers: { total: number; working: number; approval: number };
  queued: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The tray's one-line summary, as segments in reading order: subagents first (`1 of 4 subagents working`, or `4 subagents
 * finished`), then a failure count, background tasks, helpers and queued follow-ups. Zero counts are skipped. `tone` marks
 * the lead segment and failures.
 */
export function traySummary(counts: TrayCounts): { key: string; text: string; tone: "lead" | "failed" | "plain" }[] {
  const segments: { key: string; text: string; tone: "lead" | "failed" | "plain" }[] = [];
  const s = counts.subagents;
  const total = s.working + s.done + s.failed + s.stopped;
  if (total > 0) segments.push({ key: "subagents", text: stripLabel(total, s.working), tone: "lead" });
  if (s.failed > 0) segments.push({ key: "failed", text: `${s.failed} failed`, tone: "failed" });
  if (counts.tasks > 0) segments.push({ key: "tasks", text: plural(counts.tasks, "background task"), tone: "plain" });
  if (counts.helpers.total > 0) {
    const state = counts.helpers.approval > 0 ? ` · ${counts.helpers.approval} need approval` : "";
    segments.push({ key: "helpers", text: `${plural(counts.helpers.total, "helper")}${state}`, tone: "plain" });
  }
  if (counts.queued > 0) segments.push({ key: "queued", text: `${counts.queued} queued`, tone: "plain" });
  if (segments[0]) segments[0].tone = segments[0].tone === "plain" ? "lead" : segments[0].tone;
  return segments;
}

/**
 * Whether the tray starts open. Queued follow-ups and running tasks are things to keep an eye on, so it opens for them while
 * the list is short; subagents follow `subagentGroupDefaultOpen` (open while three or fewer work, closed once settled
 * unless one failed). Past `max` rows it starts closed: the summary line says everything. The reader's own choice wins.
 */
export function trayDefaultOpen(counts: TrayCounts, rows: number, max = 7): boolean {
  if (rows > max) return false;
  const total = counts.subagents.working + counts.subagents.done + counts.subagents.failed + counts.subagents.stopped;
  if (total > 0 && !subagentGroupDefaultOpen(counts.subagents)) return counts.queued > 0 || counts.tasks > 0;
  return true;
}
