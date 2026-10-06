// Detail pieces shared by the Lineage row, the results card and the inbound message row: a
// labelled section, clamped Markdown, workspace facts, the files list and conflicts.

import { useRef, useState, type ReactNode } from "react"

import {
  conflictPaths,
  diffstatLabel,
  filesLabel,
  resultNeedsClamp,
  workspaceLabel,
} from "../../../../../packages/kybern-client/src/delegations.ts"
import type { DelegationConflict, DelegationInfo, DiffStat } from "@/protocol"
import { Markdown } from "@/components/kybern/Markdown"
import { VirtualRows } from "@/components/kybern/VirtualRows"
import { TriangleAlertIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { useThreadTitle } from "@/state/delegations"

export const DETAIL_LABEL_CLASS = "text-[11px] leading-4 font-medium text-foreground/45"
const QUIET_BUTTON =
  "sa-secondary -ms-1 w-fit cursor-pointer rounded-md px-1 py-0.5 text-xs text-foreground/55 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"

export function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h4 className={DETAIL_LABEL_CLASS}>{label}</h4>
      {children}
    </section>
  )
}

/** Agent text as Markdown. Past eight lines it fades out and offers "Show more". */
export function ClampedMarkdown({ text, fontSize = 12.5, variant = "assistant" }: { text: string; fontSize?: number; /** `user` keeps the line breaks of plain text an agent wrote. */ variant?: "assistant" | "user" }) {
  const [expanded, setExpanded] = useState(false)
  const clamp = resultNeedsClamp(text)
  return (
    <>
      <div className={cn("min-w-0", clamp && !expanded && "sa-prompt-clamp max-h-[11rem]")}>
        <Markdown text={text} variant={variant} className="chat-markdown--hosted" style={{ fontSize }} />
      </div>
      {clamp && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className={QUIET_BUTTON}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  )
}

function Fact({ term, children, mono }: { term: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-[11px] leading-5 text-foreground/45">{term}</dt>
      <dd className={cn("selectable min-w-0 text-xs leading-5 break-words text-foreground/80", mono && "font-mono text-[11.5px]")}>{children}</dd>
    </>
  )
}

const short = (commit: string) => commit.slice(0, 7)

/** Where the child edited and what it changed. Renders nothing for a child with no workspace facts. */
export function WorkspaceFacts({
  info,
}: {
  info: {
    workspace: DelegationInfo["workspace"]
    worktree_state?: DelegationInfo["worktree_state"]
    branch?: string | null
    base_commit?: string | null
    head_commit?: string | null
    diffstat?: DiffStat | null
    owns?: string[]
  }
}) {
  const worktree = info.workspace === "worktree"
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
      <Fact term="Workspace">{workspaceLabel({ workspace: info.workspace, worktree_state: info.worktree_state })}</Fact>
      {worktree && info.branch && <Fact term="Branch" mono>{info.branch}</Fact>}
      {worktree && info.base_commit && <Fact term="Seeded from" mono>{short(info.base_commit)}</Fact>}
      {worktree && info.head_commit && <Fact term="Commit" mono>{short(info.head_commit)}</Fact>}
      {worktree && info.diffstat && <Fact term="Changes">{diffstatLabel(info.diffstat)}</Fact>}
      {!worktree && (info.owns?.length ?? 0) > 0 && <Fact term="Owns" mono>{info.owns!.join(", ")}</Fact>}
    </dl>
  )
}

const FILES_PREVIEW = 6

function FileLine({ file }: { file: string }) {
  const slash = file.lastIndexOf("/")
  return (
    <li className="min-w-0 truncate font-mono text-[11.5px] leading-5 text-foreground/75" title={file}>
      {slash >= 0 && <span className="text-foreground/45">{file.slice(0, slash + 1)}</span>}
      {file.slice(slash + 1)}
    </li>
  )
}

/** Six files, then "Show all" opens a bounded scroller; past 30 it is virtualized. */
export function FilesList({ files }: { files: readonly string[] }) {
  const [all, setAll] = useState(false)
  const scroller = useRef<HTMLUListElement>(null)
  if (files.length === 0) return null
  const shown = all ? files : files.slice(0, FILES_PREVIEW)
  return (
    <DetailSection label={`Files touched · ${files.length}`}>
      <ul ref={scroller} className={cn("flex min-w-0 flex-col", all && files.length > FILES_PREVIEW && "max-h-44 overflow-y-auto overscroll-contain")}>
        {all && files.length > 30 ? (
          <VirtualRows items={files} getKey={(file) => file} estimateSize={() => 20} viewport={scroller}>{(file) => <FileLine file={file} />}</VirtualRows>
        ) : (
          shown.map((file) => <FileLine key={file} file={file} />)
        )}
      </ul>
      {files.length > FILES_PREVIEW && (
        <button type="button" aria-expanded={all} onClick={() => setAll((value) => !value)} className={QUIET_BUTTON}>
          {all ? "Show fewer" : `Show all ${filesLabel(files.length)}`}
        </button>
      )}
    </DetailSection>
  )
}

function ConflictLine({ path, ownerId }: { path: string; ownerId: string }) {
  const owner = useThreadTitle(ownerId)
  return (
    <li className="flex min-w-0 items-start gap-1.5 text-xs leading-5 text-foreground/75">
      <TriangleAlertIcon className="mt-1 size-3 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 break-words">
        <span className="font-mono text-[11.5px]" title={path}>{path}</span>
        <span className="text-foreground/55">{owner ? ` is owned by “${owner}”` : " is owned by another agent"}</span>
      </span>
    </li>
  )
}

/** Paths this child edited that a sibling owns, with the owner's name. */
export function ConflictsList({ conflicts }: { conflicts: readonly DelegationConflict[] | undefined }) {
  const paths = conflictPaths({ conflicts: conflicts as DelegationConflict[] | undefined })
  if (paths.length === 0) return null
  return (
    <DetailSection label={`Conflicts · ${paths.length}`}>
      <ul className="flex flex-col gap-0.5">
        {paths.map((path) => <ConflictLine key={path} path={path} ownerId={conflicts?.find((conflict) => conflict.path === path)?.owner_thread_id ?? ""} />)}
      </ul>
    </DetailSection>
  )
}
