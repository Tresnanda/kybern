import type { ArtifactTool, JsonValue } from "./types.ts";

export interface ArtifactView {
  id: string;
  title: string;
  path: string | null;
  url: string | null;
  status: "publishing" | "published" | "failed" | "completed";
  seq: number;
}

/** Only native Artifact receipts can claim publication; prompt links cannot. */
export function artifactView(tool: ArtifactTool): ArtifactView | null {
  if (tool.call.name !== "Artifact") return null;
  const raw = tool.call.input;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (input.action === "list") return null;
  const path = typeof input.file_path === "string" ? input.file_path : null;
  const url = tool.is_error ? null : publishedUrl(tool.output);
  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title
      : path?.split(/[\\/]/).pop() || "Claude artifact";
  return {
    id: tool.call.id,
    title,
    path,
    url,
    seq: tool.seq,
    status: tool.is_error
      ? "failed"
      : url
        ? "published"
        : tool.output === null
          ? "publishing"
          : "completed",
  };
}

export function claudeArtifactUrl(value: string): string | null {
  try {
    if (/\s/.test(value)) return null;
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "claude.ai" ||
      url.port ||
      url.username ||
      url.password ||
      !/\/artifacts\/[^/]+/.test(url.pathname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function publishedUrl(value: JsonValue | null): string | null {
  let budget = 256;
  function visit(value: JsonValue | null): string | null {
    if (--budget < 0 || value === null) return null;
    if (typeof value === "string") {
      // Prefer complete URL fields; also support the native text receipt.
      if (value.length < 2048) {
        const exact = claudeArtifactUrl(value);
        if (exact) return exact;
      }
      const matches =
        value
          .slice(0, 128 * 1024)
          .match(/https:\/\/claude\.ai\/[^\s<>"'\]\)]+/g) ?? [];
      for (const match of matches) {
        const url = claudeArtifactUrl(match.replace(/[.,;]+$/, ""));
        if (url) return url;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    if (!Array.isArray(value)) {
      const fields = value as Record<string, unknown>;
      for (const key of ["url", "artifact_url", "published_url", "share_url"]) {
        const field = fields[key];
        if (typeof field === "string") {
          const url = claudeArtifactUrl(field);
          if (url) return url;
        }
      }
    }
    for (const child of Object.values(value)) {
      const url = visit(child);
      if (url) return url;
    }
    return null;
  }
  return visit(value);
}

export function publishArtifactPrompt(
  artifact: Pick<ArtifactView, "path" | "url">,
): string {
  if (!artifact.path)
    throw new Error("This artifact has no local source file.");
  return `Use Claude's native Artifact tool to publish the existing local file ${JSON.stringify(artifact.path)}.${artifact.url ? ` Update the existing artifact at ${JSON.stringify(artifact.url)} so its URL and version history are preserved.` : " Create a hosted Claude artifact."} If the source is React, SVG, or another format, first prepare the HTML or Markdown file required by the tool. Choose an appropriate favicon. Preserve the file's functionality and declared connector capabilities. On republish, omit capabilities and contract to preserve their existing values unless this update requires changes. Never force an overwrite of a newer version. Report the URL returned by the tool. Do not claim publication if the tool fails.`;
}
