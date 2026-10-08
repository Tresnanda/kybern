// How the transcript reads `kybern_preview_open`: a one-line label ("Opened preview · mockup.html")
// and the target to reopen. Every harness spells the tool its own way (`mcp__kybern__kybern_preview_open`
// for Claude, the bare name for pi). Pure, so the mobile client can reuse it.

import type { JsonValue } from "./types.ts";

const TOOL_PATTERN = /(?:^|[^a-z0-9])kybern_preview_open$/;

export function isPreviewOpenTool(name: string): boolean {
  return TOOL_PATTERN.test(name.toLowerCase());
}

export type PreviewToolRequest = { target: string; title?: string };

/** The `target` (and optional `title`) the agent asked to show. */
export function previewToolRequest(input: JsonValue | null | undefined): PreviewToolRequest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { target, title } = input as Record<string, unknown>;
  if (typeof target !== "string" || !target.trim()) return null;
  return { target: target.trim(), ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}) };
}

/** A short name for the page: its title, the file name, or the host. */
export function previewToolName(request: PreviewToolRequest): string {
  if (request.title) return request.title;
  const target = request.target;
  if (/^https?:\/\//i.test(target)) {
    try {
      return new URL(target).host;
    } catch {
      return target;
    }
  }
  const clean = target.split(/[?#]/)[0].replace(/\/+$/, "");
  return clean.split("/").pop() || target;
}

export function previewToolLabel(input: JsonValue | null | undefined, complete: boolean, isError: boolean): string {
  if (isError) return "Unable to open preview";
  const request = previewToolRequest(input);
  const name = request ? ` · ${previewToolName(request)}` : "";
  return `${complete ? "Opened" : "Opening"} preview${name}`;
}
