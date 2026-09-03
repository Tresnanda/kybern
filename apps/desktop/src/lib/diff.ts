// Unified-diff parser: files -> hunks -> numbered lines.

export type DiffLineKind = "add" | "del" | "ctx"

export interface DiffLine {
  kind: DiffLineKind
  /** Line text without the leading marker. */
  text: string
  oldNo: number | null
  newNo: number | null
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath: string | null
  status: "added" | "deleted" | "modified" | "renamed"
  binary: boolean
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parseUnifiedDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
      file = { path: m?.[2] ?? "", oldPath: null, status: "modified", binary: false, hunks: [], additions: 0, deletions: 0 }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (raw.startsWith("new file mode")) {
      file.status = "added"
      continue
    }
    if (raw.startsWith("deleted file mode")) {
      file.status = "deleted"
      continue
    }
    if (raw.startsWith("rename from ")) {
      file.oldPath = raw.slice("rename from ".length)
      file.status = "renamed"
      continue
    }
    if (raw.startsWith("Binary files")) {
      file.binary = true
      continue
    }
    if (raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("similarity") || raw.startsWith("rename to ") || raw.startsWith("old mode") || raw.startsWith("new mode")) continue
    const h = HUNK_RE.exec(raw)
    if (h) {
      hunk = {
        header: h[5]?.trim() ?? "",
        oldStart: Number(h[1]),
        oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newCount: h[4] === undefined ? 1 : Number(h[4]),
        lines: [],
      }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (raw === "\\ No newline at end of file") continue
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ })
      file.additions++
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null })
      file.deletions++
    } else if (raw.startsWith(" ") || raw === "") {
      hunk.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return files
}
