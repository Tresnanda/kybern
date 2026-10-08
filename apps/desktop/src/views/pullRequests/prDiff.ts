import { parseUnifiedDiff, type FileDiff } from "@/lib/diff"
import type { PrFile } from "@/protocol"

export function prFileDiff(file: PrFile): FileDiff {
  const patch = `diff --git a/${file.old_path ?? file.path} b/${file.path}\n--- a/${file.old_path ?? file.path}\n+++ b/${file.path}\n${file.patch}`
  const parsed = parseUnifiedDiff(patch)[0]
  return {
    path: file.path,
    oldPath: file.old_path,
    status:
      file.status === "added"
        ? "added"
        : file.status === "removed"
          ? "deleted"
          : "modified",
    binary: !file.patch,
    hunks: parsed?.hunks ?? [],
    additions: file.additions,
    deletions: file.deletions,
  }
}

/** GitHub anchors each file in a pull request's Files tab by the SHA-256 of its path. */
export async function prFileUrl(prUrl: string, path: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path))
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
    return `${prUrl}/files#diff-${hex}`
  } catch {
    return `${prUrl}/files`
  }
}
