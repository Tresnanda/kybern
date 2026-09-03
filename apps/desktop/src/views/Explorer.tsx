// Explorer dock pane, after Synara's DockExplorerPane: a fixed search box
// over a lazily loaded file tree (BeUI File Tree) in a w-60 column, next to a
// file viewer with a breadcrumb header, syntax highlighting and a markdown
// preview switch.

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/beui/file-tree"
import { highlightToHtml, languageForPath, Markdown, useIsDark } from "@/components/kybern/Markdown"
import { Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/synara/button"
import { IconButton } from "@/components/synara/icon-button"
import { ComposerPickerMenuPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import { FileEntryIcon } from "@/components/synara/chat/FileEntryIcon"
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "@/components/synara/menu"
import { SearchInput } from "@/components/synara/search-input"
import { Skeleton } from "@/components/synara/skeleton"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/synara/tooltip"
import { ResizeHandle } from "@/components/kybern/ResizeHandle"
import { copyText, useResize } from "@/lib/hooks"
import { basename } from "@/lib/format"
import { ChevronRightIcon, CodeIcon, CopyIcon, EllipsisIcon, EyeOpenIcon, FolderIcon } from "@/lib/synara/icons"
import { revealInFinder } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { FileEntry, FilesReadResult, ProjectId } from "@/protocol"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"

const SEARCH_DEBOUNCE_MS = 120
const SEARCH_LIMIT = 80
const ROW = "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left font-system-ui text-[length:var(--app-font-size-ui,12px)] text-foreground/85 outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] focus-visible:bg-[var(--color-background-elevated-secondary)]"

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function parentDirs(path: string): string[] {
  const parts = path.split("/")
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"))
  return out
}

export function ExplorerPane({ projectId }: { projectId: ProjectId }) {
  const project = useStore((s) => s.projects[projectId])
  const selected = useStore((s) => s.explorerFile[projectId] ?? null)
  const set = useStore((s) => s.set)
  const [listings, setListings] = useState<Record<string, FileEntry[] | "loading" | "error">>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [results, setResults] = useState<string[] | null>(null)
  // Directories already requested for this project, so repeated expands don't refetch.
  const requested = useRef(new Set<string>())

  const load = useCallback(
    (dir: string) => {
      if (requested.current.has(dir)) return
      requested.current.add(dir)
      setListings((l) => ({ ...l, [dir]: "loading" }))
      rpc()
        .call("files.list", { project_id: projectId, path: dir })
        .then((r) => setListings((l) => ({ ...l, [dir]: r.entries })))
        .catch((e) => {
          setListings((l) => ({ ...l, [dir]: "error" }))
          toast.error("Unable to list folder", { description: errorText(e) })
        })
    },
    [projectId],
  )

  useEffect(() => {
    requested.current = new Set()
    setListings({})
    setExpanded([])
    load("")
  }, [projectId, load])

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query])

  useEffect(() => {
    if (!debounced) {
      setResults(null)
      return
    }
    let live = true
    rpc()
      .call("files.search", { project_id: projectId, query: debounced, limit: SEARCH_LIMIT })
      .then((r) => live && setResults(r.files))
      .catch(() => live && setResults([]))
    return () => {
      live = false
    }
  }, [debounced, projectId])

  const select = useCallback(
    (path: string | null) => {
      set((s) => ({ explorerFile: { ...s.explorerFile, [projectId]: path } }))
    },
    [projectId, set],
  )

  const reveal = useCallback(
    (path: string) => {
      const dirs = parentDirs(path)
      setExpanded((cur) => Array.from(new Set([...cur, ...dirs])))
      for (const d of dirs) load(d)
      select(path)
      setQuery("")
    },
    [load, select],
  )

  const onExpandedChange = (ids: string[]) => {
    setExpanded(ids)
    for (const id of ids) load(id)
  }

  const renderDir = (dir: string): React.ReactNode => {
    const entries = listings[dir]
    if (entries === "loading" || entries === undefined) return <FileTreeFile value={`${dir}/…loading`} name="Loading…" disabled icon={<Spinner size={12} />} />
    if (entries === "error") return <FileTreeFile value={`${dir}/…error`} name="Could not read folder" disabled />
    if (entries.length === 0) return <FileTreeFile value={`${dir}/…empty`} name="Empty folder" disabled />
    return entries.map((e) =>
      e.kind === "directory" ? (
        <FileTreeFolder key={e.path} value={e.path} name={e.name}>
          {expanded.includes(e.path) ? renderDir(e.path) : <FileTreeFile value={`${e.path}/…`} name="" disabled className="hidden" />}
        </FileTreeFolder>
      ) : (
        <FileTreeFile key={e.path} value={e.path} name={e.name} icon={<FileEntryIcon pathValue={e.path} kind="file" className="size-3.5" />} />
      ),
    )
  }

  const root = listings[""]
  const column = useResize({ initial: 240, min: 176, max: 520, side: "left", storageKey: "kybern.explorer.width" })

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-border/65 bg-[var(--color-background-surface)]" style={{ width: column.width }}>
        <ResizeHandle edge="right" label="Resize file tree" onPointerDown={column.onPointerDown} dragging={column.dragging} />
        <div className="p-2">
          <SearchInput placeholder="Search files..." value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search files" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {debounced ? (
            results === null ? (
              <LoadingRows />
            ) : results.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-muted-foreground/60">No files match.</p>
            ) : (
              <ul className="flex flex-col gap-px">
                {results.map((path) => (
                  <li key={path}>
                    <button type="button" onClick={() => reveal(path)} title={path} className={cn(ROW, selected === path && "bg-[var(--color-background-button-secondary)] text-foreground")}>
                      <FileEntryIcon pathValue={path} kind="file" className="size-3.5" />
                      <span className="min-w-0 truncate">{basename(path)}</span>
                      <span className="ml-auto min-w-0 max-w-[45%] truncate text-[10.5px] text-muted-foreground/50">{path.slice(0, path.length - basename(path).length)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : root === undefined || root === "loading" ? (
            <LoadingRows />
          ) : root === "error" ? (
            <p className="px-2 py-3 text-[11px] text-destructive/85">Could not read the project folder.</p>
          ) : (
            <FileTree
              value={selected}
              onValueChange={(v) => {
                if (v.includes("/…")) return
                const isDir = findEntry(listings, v)?.kind === "directory"
                if (!isDir) select(v)
              }}
              expandedIds={expanded}
              onExpandedChange={onExpandedChange}
              ariaLabel={`${project?.name ?? "Project"} files`}
              className="gap-px"
            >
              {renderDir("")}
            </FileTree>
          )}
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        {selected ? (
          <FileViewer key={`${projectId}:${selected}`} projectId={projectId} path={selected} projectName={project?.name ?? "Project"} projectPath={project?.path ?? ""} />
        ) : (
          <div className="flex w-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70">Select a file from the tree to view it.</div>
        )}
      </div>
    </div>
  )
}

function findEntry(listings: Record<string, FileEntry[] | "loading" | "error">, path: string): FileEntry | undefined {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
  const list = listings[dir]
  if (!Array.isArray(list)) return undefined
  return list.find((e) => e.path === path)
}

function LoadingRows() {
  return (
    <div className="space-y-1.5 py-1.5 pr-2 pl-2">
      {["w-9/12", "w-6/12", "w-7/12"].map((w, i) => (
        <div key={i} className="flex h-5 items-center gap-2">
          <Skeleton className="size-3.5 shrink-0 rounded-sm opacity-60" />
          <Skeleton className={cn("h-2.5 rounded-full", w)} />
        </div>
      ))}
    </div>
  )
}

function FileViewer({ projectId, path, projectName, projectPath }: { projectId: ProjectId; path: string; projectName: string; projectPath: string }) {
  const dark = useIsDark()
  const [file, setFile] = useState<FilesReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(path)
  const [preview, setPreview] = useState(isMarkdown)
  const name = basename(path)
  const dirs = path.slice(0, path.length - name.length).split("/").filter(Boolean)

  useEffect(() => {
    let live = true
    setFile(null)
    setError(null)
    setHtml(null)
    rpc()
      .call("files.read", { project_id: projectId, path })
      .then((r) => live && setFile(r))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [projectId, path])

  useEffect(() => {
    if (!file || file.binary || !file.content) return
    let live = true
    highlightToHtml(file.content, languageForPath(path), dark)
      .then((h) => live && setHtml(h))
      .catch(() => live && setHtml(null))
    return () => {
      live = false
    }
  }, [file, path, dark])

  const lineCount = file?.content ? file.content.split("\n").length : 0

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)]">
      <div className="chat-surface-divider flex h-9 shrink-0 items-center gap-2 px-3">
        <nav aria-label="File path" className="flex min-w-0 flex-1 items-center gap-1 font-system-ui text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/55">
          <span className="inline-flex shrink-0 items-center gap-1">
            <FolderIcon className="size-3 shrink-0" />
            <span className="truncate">{projectName}</span>
          </span>
          {dirs.map((d, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1">
              <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/35" />
              <span className="truncate">{d}</span>
            </span>
          ))}
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/35" />
          <span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground/90">{name}</span>
          {file?.truncated && <span className="ml-1 shrink-0 rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 text-[10px] text-muted-foreground">partial</span>}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          {isMarkdown && (
            <div role="radiogroup" aria-label="Markdown view" className="inline-flex items-center gap-0.5 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5">
              {(
                [
                  [false, "Source", CodeIcon],
                  [true, "Preview", EyeOpenIcon],
                ] as const
              ).map(([rendered, label, Icon]) => (
                <Tooltip key={label}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="radio"
                        aria-checked={preview === rendered}
                        aria-label={label}
                        onClick={() => setPreview(rendered)}
                        className={cn("inline-flex size-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors", preview === rendered && "bg-[var(--color-background-surface)] text-foreground shadow-sm")}
                      />
                    }
                  >
                    <Icon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">{label}</TooltipPopup>
                </Tooltip>
              ))}
            </div>
          )}
          <Menu>
            <IconButton render={<MenuTrigger />} variant="chrome" size="icon-xs" label="File actions" tooltip="More" tooltipSide="bottom" className="!size-7 rounded-lg [&_svg,&_[data-slot=central-icon]]:mx-0">
              <EllipsisIcon className="size-3.5" />
            </IconButton>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-52 min-w-52">
              <MenuGroup>
                <MenuItem onClick={() => void copyText(path)}>
                  <CopyIcon className="size-3.5 shrink-0 text-muted-foreground" /> Copy relative path
                </MenuItem>
                <MenuItem onClick={() => void copyText(`${projectPath}/${path}`)}>
                  <CopyIcon className="size-3.5 shrink-0 text-muted-foreground" /> Copy absolute path
                </MenuItem>
                <MenuItem disabled={!file || file.binary} onClick={() => file && void copyText(file.content)}>
                  <CopyIcon className="size-3.5 shrink-0 text-muted-foreground" /> Copy contents
                </MenuItem>
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup>
                <MenuItem onClick={() => void revealInFinder(`${projectPath}/${path}`)}>
                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" /> Reveal in Finder
                </MenuItem>
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
        </div>
      </div>

      {error ? (
        <div className="flex items-start justify-start p-3">
          <p className="text-left text-[11px] text-destructive/85">{error}</p>
        </div>
      ) : !file ? (
        <div className="min-h-0 flex-1 space-y-2.5 overflow-hidden px-3 py-3">
          {[["w-8/12", 0], ["w-5/12", 1], ["w-9/12", 1], ["w-4/12", 2], ["w-7/12", 1], ["w-3/12", 0]].map(([w, indent], i) => (
            <div key={i} className="flex h-3 items-center gap-2" style={{ paddingLeft: Number(indent) * 14 }}>
              <Skeleton className="h-2.5 w-5 shrink-0 rounded-full opacity-60" />
              <Skeleton className={cn("h-2.5 rounded-full", String(w))} />
            </div>
          ))}
          <span className="sr-only">Loading file...</span>
        </div>
      ) : file.binary ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground/70">
          <FileEntryIcon pathValue={path} kind="file" className="size-5 opacity-70" />
          <p>Binary file, {formatBytes(file.size)}.</p>
          <Button size="xs" variant="chrome-outline" onClick={() => void revealInFinder(`${projectPath}/${path}`)}>
            Reveal in Finder
          </Button>
        </div>
      ) : isMarkdown && preview ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-[46rem] px-5 py-4">
            <Markdown text={file.content} style={{ fontSize: 12, lineHeight: "19.5px" }} />
          </div>
        </div>
      ) : (
        <div className="editor-file-viewer selectable min-h-0 flex-1 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {html ? (
            <div className="editor-file-viewer__highlight min-h-full [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="editor-file-viewer__plain min-h-full" aria-readonly="true">
              {file.content}
            </pre>
          )}
          <span className="sr-only">{lineCount} lines</span>
        </div>
      )}
    </div>
  )
}
