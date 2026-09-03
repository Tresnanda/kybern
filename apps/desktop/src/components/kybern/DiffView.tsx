// Unified diff renderer, styled after Synara's FileDiffCard: a sticky file
// header (icon, name, directory, +/- stats), then numbered rows with the
// diff background tokens. Shared by the dock and the inline "Edited N files"
// card in the transcript.

import { useState } from "react"

import { DisclosureChevron } from "@/components/synara/DisclosureChevron"
import { DiffStatLabel } from "@/components/synara/chat/DiffStatLabel"
import type { DiffHunk, FileDiff } from "@/lib/diff"
import { basename } from "@/lib/format"
import { FileIcon } from "@/lib/synara/icons"
import { cn } from "@/lib/utils"

const ADD_BG = "bg-[color-mix(in_srgb,var(--background)_92%,var(--success))]"
const ADD_NUM_BG = "bg-[color-mix(in_srgb,var(--background)_88%,var(--success))]"
const DEL_BG = "bg-[color-mix(in_srgb,var(--background)_92%,var(--destructive))]"
const DEL_NUM_BG = "bg-[color-mix(in_srgb,var(--background)_88%,var(--destructive))]"
const SEP_BG = "bg-[color-mix(in_srgb,var(--background)_95%,var(--foreground))]"

export function FileDiffHeader({ file, open, onToggle, trailing }: { file: FileDiff; open?: boolean; onToggle?: () => void; trailing?: React.ReactNode }) {
  const name = basename(file.path)
  const dir = file.path.slice(0, file.path.length - name.length)
  const Comp = onToggle ? "button" : "div"
  return (
    <Comp
      type={onToggle ? "button" : undefined}
      onClick={onToggle}
      className={cn(
        "sticky top-0 z-[4] flex w-full min-w-0 items-center gap-2 border-b border-[color:var(--color-border)] bg-[var(--background)] px-2.5 py-1.5 text-left font-system-ui text-[length:var(--app-font-size-ui,12px)] text-foreground",
        onToggle && "cursor-pointer",
      )}
    >
      {onToggle && <DisclosureChevron open={!!open} className="size-3.5 opacity-50" />}
      <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/60">
        <FileIcon className="size-3.5 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80" />
      </span>
      {file.oldPath && <span className="shrink-0 text-[11.5px] text-muted-foreground/65 line-through">{basename(file.oldPath)}</span>}
      {file.oldPath && <span className="text-[11px] text-muted-foreground/45">→</span>}
      <span className="shrink-0 truncate text-[11.5px] font-medium text-foreground/85">{name}</span>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground/55">{dir}</span>
      {file.status === "added" && <span className="shrink-0 rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 text-[10px] text-muted-foreground">new</span>}
      {file.status === "deleted" && <span className="shrink-0 rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 text-[10px] text-muted-foreground">deleted</span>}
      <span className="ml-auto shrink-0 text-[10px] tabular-nums">
        <DiffStatLabel additions={file.additions} deletions={file.deletions} />
      </span>
      {trailing}
    </Comp>
  )
}

function HunkRows({ hunk, first }: { hunk: DiffHunk; first: boolean }) {
  return (
    <>
      <tr className={cn(SEP_BG, "font-system-ui text-muted-foreground")}>
        <td colSpan={2} className={cn("w-px py-0.5 pr-2 pl-3 text-right whitespace-nowrap text-muted-foreground/45 select-none", !first && "border-t border-[color:var(--color-border-light)]")}>
          ⋯
        </td>
        <td className={cn("py-0.5 pr-3 pl-[1.25ch] text-[11px]", !first && "border-t border-[color:var(--color-border-light)]")}>
          {hunk.header ? hunk.header : `Lines ${hunk.newStart}–${hunk.newStart + Math.max(hunk.newCount - 1, 0)}`}
        </td>
      </tr>
      {hunk.lines.map((l, i) => (
        <tr key={i} className={cn(l.kind === "add" && ADD_BG, l.kind === "del" && DEL_BG, l.kind === "ctx" && "hover:bg-[color-mix(in_srgb,var(--background)_96%,var(--foreground))]")}>
          <td className={cn("w-px min-w-[3ch] pr-1 pl-3 text-right align-top font-system-ui tabular-nums text-muted-foreground/45 select-none", l.kind === "add" && ADD_NUM_BG, l.kind === "del" && DEL_NUM_BG)}>
            {l.oldNo ?? ""}
          </td>
          <td className={cn("w-px min-w-[3ch] pr-1.5 text-right align-top font-system-ui tabular-nums text-muted-foreground/45 select-none", l.kind === "add" && ADD_NUM_BG, l.kind === "del" && DEL_NUM_BG)}>
            {l.newNo ?? ""}
          </td>
          <td className="pr-3 pl-[1.25ch] align-top whitespace-pre">
            <span className={cn("inline-block w-[1.5ch] select-none", l.kind === "add" ? "text-[var(--color-decoration-added)]" : l.kind === "del" ? "text-[var(--color-decoration-deleted)]" : "text-transparent")}>
              {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
            </span>
            {l.text}
          </td>
        </tr>
      ))}
    </>
  )
}

export function FileDiffBody({ file }: { file: FileDiff }) {
  if (file.binary) return <p className="px-3 py-2 text-[11px] text-muted-foreground/75">Binary file changed.</p>
  if (file.hunks.length === 0) return <p className="px-3 py-2 text-[11px] text-muted-foreground/75">No textual changes.</p>
  return (
    <div className="selectable overflow-x-auto">
      <table className="w-full border-collapse font-chat-code text-[length:var(--app-font-size-chat-code,11px)] leading-[1.65] text-foreground">
        <tbody>
          {file.hunks.map((h, i) => (
            <HunkRows key={i} hunk={h} first={i === 0} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Collapsible per-file card: header + body. Supports controlled lazy loading. */
export function FileDiffCard({
  file,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  loading = false,
  error = false,
  className,
}: {
  file: FileDiff
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  loading?: boolean
  error?: boolean
  className?: string
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  const toggle = () => {
    const next = !open
    if (onOpenChange) onOpenChange(next)
    else setUncontrolledOpen(next)
  }
  return (
    <div className={cn("diff-render-file overflow-hidden rounded-md border border-[color:var(--color-border)]", className)}>
      <FileDiffHeader file={file} open={open} onToggle={toggle} />
      {open &&
        (loading ? (
          <p className="shimmer px-3 py-2 text-[11px] text-muted-foreground/75">Loading changes…</p>
        ) : error ? (
          <p className="px-3 py-2 text-[11px] text-destructive">Unable to load this file’s changes.</p>
        ) : (
          <FileDiffBody file={file} />
        ))}
    </div>
  )
}
