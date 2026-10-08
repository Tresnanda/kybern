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
