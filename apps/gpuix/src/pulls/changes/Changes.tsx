// The pull request's Changes tab: a file tree (or flat list) with a Viewed box per file, and the selected
// file's diff. The list fills the pane; pages of files load in the background (`useFiles.ts`), and Viewed marks
// persist per pull request and file blob (`model.ts`, `viewed.ts`).
import { LinkSquare02Icon, ListViewIcon } from '@hugeicons/core-free-icons'
import { glyph, Icon } from '../../icons.tsx'
import { N } from '../../nav/glyphs.ts'
import { Tip } from '../../nav/overlay.tsx'
import { alpha } from '../../transcript/kit.tsx'
import { NativeDiffHeader } from '../../native/DiffView.tsx'
import { desktopDiffTheme } from '../../native/diff.ts'
import { diffFileIcons } from '../../native/diff-file-icons.ts'
import { parseUnifiedDiff } from '../../shared/lib/diff.ts'
import { getFileIconName } from '../../shared/lib/kit/fileIcons.ts'
import { Button } from '../../kit/Button.tsx'
import { Checkbox } from '../../kit/Checkbox.tsx'
import { IconButton } from '../../kit/IconButton.tsx'
import { SearchField } from '../../kit/SearchField.tsx'
import { TextArea } from '../../kit/TextArea.tsx'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { reviewDraftIsStale } from '@/state/prReviewModel'
import { prFileUrl } from '@/views/pullRequests/prDiff'
import { Label, ink, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { load, save } from '../persist.ts'
import { PR_SCROLL_LAYOUT } from '../scroll-layout.ts'
import { openUrl, PrLoading, Problem } from '../PrStates.tsx'
import type { Review } from '../useReview.ts'
import { filterFiles, flattenList, flattenTree, prKey, rangeBetween, viewedCount, viewedLabel, viewedState, visibleFiles, type FileMeta, type Row, type ViewedState } from './model.ts'
import { useChangedFiles, usePatch } from './useFiles.ts'
import { useViewed } from './viewed.ts'

const ROW_HEIGHT = 26
const INDENT = 14
const LIST_WIDTH = 320
const COMPACT_LIST_HEIGHT = 272
const MODE_KEY = 'pulls.changes.mode'

/** Tabular numerals for counts, stats and durations (the style type does not list the property). */
const num = (style: object = {}) => ({ ...style, fontVariantNumeric: 'tabular-nums' }) as never
const fmt = (n: number) => n.toLocaleString('en-US')


export function Changes({ projectId, number, repo, review, compact = false }: { projectId: string; number: number; repo?: string; review: Review; compact?: boolean }) {
  const t = useTheme()
  const [path, setPath] = useState<string | null>(null)
  const [mode, setMode] = useState<'tree' | 'list'>(() => (load<string>(MODE_KEY, 'tree') === 'list' ? 'list' : 'tree'))
  const [query, setQuery] = useState('')
  const list = useChangedFiles(projectId, number, repo, review.revision, review.detail?.head_sha)
  const { files } = list
  const key = prKey(projectId, number, repo)
  const viewed = useViewed(key)
  const collapsed = useMemo(() => new Set(viewed.entry?.closed ?? []), [viewed.entry?.closed])
  const filtering = query.trim() !== ''
  const rows = useMemo<Row[]>(() => {
    const shown = filterFiles(files, query)
    return mode === 'tree' ? flattenTree(shown, collapsed, filtering) : flattenList(shown)
  }, [files, query, mode, collapsed, filtering])
  const order = useMemo(() => visibleFiles(rows), [rows])
  /** Test ids count files only, so `pr-file-1` is the second file whatever the folders between. */
  const fileIndex = useMemo(() => new Map(order.map((f, i) => [f.path, i])), [order])
  const anchor = useRef<string | null>(null)

  // The first file in reading order is selected once, so more pages arriving never move the selection.
  useEffect(() => { if (!path && order[0]) setPath(order[0].path) }, [path, order])
  const selected = files.find(f => f.path === path)
  const patchOf = usePatch(projectId, number, repo, review.revision, review.detail?.head_sha, selected)
  const file = patchOf.file
  const patch = useMemo(() => file ? `diff --git a/${file.old_path ?? file.path} b/${file.path}\n--- a/${file.old_path ?? file.path}\n+++ b/${file.path}\n${file.patch}` : '', [file])
  const pending = review.draft.pendingInline
  const stale = review.detail ? reviewDraftIsStale(review.draft, review.detail.head_sha) : false
  const [lineError, setLineError] = useState<string | null>(null)
  const [visibleLines, setVisibleLines] = useState(600)
  // The desktop table sizes its gutters from the currently expanded rows.
  // Native diff knows the full patch, so adjust its digit metric until expanded.
  const diffTheme = useMemo(() => {
    const theme = desktopDiffTheme(t, false)
    const lines = parseUnifiedDiff(patch).flatMap(f => f.hunks.flatMap(h => h.lines))
    const maxNumber = (rows: typeof lines) => rows.reduce((n, l) => Math.max(n, l.oldNo ?? 0, l.newNo ?? 0), 1)
    const digits = String(maxNumber(lines)).length
    const shownDigits = String(maxNumber(lines.slice(0, visibleLines))).length
    if (shownDigits < digits) theme.diff = { ...theme.diff, gutterDigitWidth: 13 * .62415 * shownDigits / digits }
    return theme
  }, [t, patch, visibleLines])

  const select = useCallback((next: string) => { setPath(next); setVisibleLines(600) }, [])
  const toggleDir = useCallback((dir: string) => {
    const next = new Set(collapsed)
    if (!next.delete(dir)) next.add(dir)
    viewed.close([...next])
  }, [collapsed, viewed])
  const mark = useCallback((target: FileMeta, on: boolean, shift: boolean) => {
    const from = anchor.current
    anchor.current = target.path
    viewed.mark(shift && from && from !== target.path ? rangeBetween(order, from, target.path) : [target], on)
  }, [order, viewed])
  const setModeSaved = (next: 'tree' | 'list') => { setMode(next); save(MODE_KEY, next) }

  const total = Math.max(review.detail?.changed_files ?? 0, files.length)
  const done = viewedCount(viewed.entry, files)
  const selectedState = selected ? viewedState(viewed.entry, selected) : 'none'

  return <div testId="pr-changes" style={{ ...column, flexGrow: 1, minHeight: 0, paddingTop: 16, paddingBottom: 16, paddingLeft: compact ? 14 : 24, paddingRight: compact ? 14 : 24, gap: 12 }}>
    {list.error && !files.length ? <Problem error={list.error} refresh={review.refresh} /> : <>
      <div style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', flexGrow: 1, minHeight: 0, gap: 16 }}>
        <div testId="pr-files-column" style={{ ...column, ...(compact ? { width: '100%', height: COMPACT_LIST_HEIGHT } : { width: LIST_WIDTH }), flexShrink: 0, minHeight: 0, gap: 8 }}>
          <div style={{ ...column, gap: 8, paddingLeft: 6, paddingRight: 6, flexShrink: 0 }}>
            <div style={{ ...row, gap: 6, height: 24 }}>
              <Label color={t.text} size={12.5} lineHeight={16} weight={600} style={num({ flexShrink: 0 })}>{`${fmt(total)} ${total === 1 ? 'file' : 'files'}`}</Label>
              <Label color={t.textTertiary} size={12.5} lineHeight={16} style={{ flexShrink: 0 }}>·</Label>
              <Label color={t.textSecondary} size={12.5} lineHeight={16} truncate style={num({ flexGrow: 1 })}>{viewedLabel(done, total)}</Label>
              <Tip label="File tree" side="bottom" size={24}><IconButton testId="pr-mode-tree" icon={N.folder} size="sm" glyph={14} active={mode === 'tree'} label="Show as a tree" onClick={() => setModeSaved('tree')} /></Tip>
              <Tip label="Flat list" side="bottom" size={24}><IconButton testId="pr-mode-list" icon={glyph(ListViewIcon)} size="sm" glyph={14} active={mode === 'list'} label="Show as a list" onClick={() => setModeSaved('list')} /></Tip>
            </div>
            <div style={{ height: 3, borderRadius: 2, backgroundColor: ink(t, .06), flexDirection: 'row', display: 'flex', overflow: 'hidden' }}><div testId="pr-viewed-bar" style={{ height: 3, borderRadius: 2, width: `${total ? Math.min(100, done / total * 100) : 0}%`, backgroundColor: t.textSecondary }} /></div>
            <SearchField testId="pr-files-filter" label="Filter files" placeholder="Filter files" value={query} onChange={setQuery} />
          </div>
          <virtual-list {...PR_SCROLL_LAYOUT} testId="pr-files" estimatedItemHeight={ROW_HEIGHT} style={{ flexGrow: 1, minHeight: 0, paddingLeft: 6, paddingRight: 6 }}>
            {rows.map(r => r.kind === 'dir'
              ? <DirRow key={`d:${r.key}`} row={r} onToggle={toggleDir} />
              : <FileRow key={`f:${r.key}`} index={fileIndex.get(r.key) ?? 0} row={r} tree={mode === 'tree'} selected={selected?.path === r.file.path} state={viewedState(viewed.entry, r.file)} draft={review.draft.inline.some(c => c.path === r.file.path)} onSelect={select} onMark={mark} />)}
            {!list.loaded && <div key="loading" style={{ padding: 8 }}><PrLoading label="Loading files…" rows={6} /></div>}
            {list.loaded && !rows.length && <div key="empty" style={{ padding: 8 }}><Label color={t.textSecondary} size={13}>{filtering ? 'No files match this filter.' : 'No changed files.'}</Label></div>}
            {list.loaded && !list.done && !list.paused && !list.error && <div key="more" style={{ ...row, height: ROW_HEIGHT, paddingLeft: 8 }}><Label color={t.textTertiary} size={12} style={num()}>{`Loading more files… ${fmt(files.length)} of ${fmt(total)}`}</Label></div>}
            {(list.paused || (list.error && files.length > 0)) && <div key="resume" style={{ ...column, gap: 6, padding: 8 }}>
              {list.error && <Label color={t.warning} size={12}>{`Could not load more files. ${list.error}`}</Label>}
              <Button testId="pr-files-more" size="sm" onClick={list.more}>{list.error ? 'Try again' : `Load more files (${fmt(files.length)} of ${fmt(total)})`}</Button>
            </div>}
          </virtual-list>
        </div>
        <div style={{ ...column, flexGrow: 1, minWidth: 0, minHeight: 0, borderWidth: selected ? 1 : 0, borderColor: t.border, borderRadius: 8, overflow: 'hidden' }}>
          {!selected ? (list.loaded ? <Label color={t.textSecondary} size={13}>No changed files.</Label> : <div style={{ padding: 16 }}><PrLoading label="Loading changes…" rows={7} /></div>) : <>
            <div style={{ ...row, gap: 0, height: 37, flexShrink: 0, borderBottomWidth: 1, borderColor: t.border, backgroundColor: t.v('--background') }}>
              <div style={{ flexGrow: 1, minWidth: 0 }}><NativeDiffHeader file={{ ...selected, oldPath: selected.old_path }} /></div>
              <ViewedButton state={selectedState} onToggle={(on, shift) => mark(selected, on, shift)} />
              <IconButton icon={glyph(LinkSquare02Icon)} size="sm" glyph={14} label="Open file on GitHub" onClick={() => { if (review.detail) void prFileUrl(review.detail.pull_request.url, selected.path).then(openUrl) }} />
            </div>
            {selectedState === 'changed' && <div testId="pr-file-changed" style={{ ...row, gap: 6, height: 28, flexShrink: 0, paddingLeft: 12, borderBottomWidth: 1, borderColor: t.border }}><Dot color={t.link} /><Label color={t.link} size={12} weight={500}>Changed since you viewed it</Label></div>}
            {patchOf.loading ? <div style={{ padding: 16 }}><PrLoading label="Loading patch…" rows={5} /></div> : file?.patch ? <diff key={file.path} {...PR_SCROLL_LAYOUT} testId="pr-native-diff" patch={patch} scroll theme={diffTheme} maxLines={visibleLines} onShowMore={() => setVisibleLines(n => n + 600)} onLineClick={e => {
              if (stale) { setLineError('This draft belongs to a different commit. Resolve the previous draft before choosing a new inline anchor.'); return }
              if (pending?.body.trim()) { setLineError('Add this comment to the review or cancel it before choosing another line.'); return }
              const line = e.newLine && e.newLine > 0 ? e.newLine : e.oldLine
              if (!line || line < 1) return
              setLineError(null)
              review.updateDraft({ pendingInline: { path: file.path, line, side: e.newLine && e.newLine > 0 ? 'RIGHT' : 'LEFT', body: '' } })
            }} style={{ userSelect: 'text', flexGrow: 1, minHeight: 100, minWidth: 0 }} /> : <Label color={t.textSecondary} size={12}>No patch available for this file.</Label>}
            {(file?.patch_truncated ?? selected.patch_truncated) && <Label color={t.textSecondary} size={11}>GitHub omitted or truncated this patch. Open the pull request on GitHub to read the full file.</Label>}
          </>}
        </div>
      </div>
    </>}
    {lineError && <Label color={t.warning} size={12}>{lineError}</Label>}
    {pending && <div style={{ ...column, gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: t.border }}><Label color={t.text} size={12}>{`Comment on line ${pending.line} · ${pending.side === 'LEFT' ? 'original' : 'new'} version · ${pending.path}`}</Label><TextArea label="Inline comment" testId="pr-inline-body" autoFocus minRows={2} maxRows={4} value={pending.body} onChange={v => review.updateDraft({ pendingInline: { ...pending, body: v.slice(0, 65536) } })} /><div style={{ ...row, justifyContent: 'flex-end', gap: 8 }}><Button variant="ghost" onClick={() => { review.updateDraft({ pendingInline: null }); setLineError(null) }}>Cancel</Button><Button testId="pr-inline-save" variant="primary" disabled={!pending.body.trim() || stale || review.draft.inline.length >= 100} onClick={() => { review.updateDraft({ inline: [...review.draft.inline, pending], pendingInline: null }); setLineError(null) }}>Add to review</Button></div></div>}
  </div>
}

const Dot = ({ color }: { color: string }) => <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, flexShrink: 0 }} />

/** Both the box and its label toggle; a click on the box is also a click on the pill, so the second is dropped. */
let toggledAt = 0
function ViewedButton({ state, onToggle }: { state: ViewedState; onToggle: (on: boolean, shift: boolean) => void }) {
  const t = useTheme()
  const on = state === 'viewed'
  const flip = (shift: boolean) => { if (performance.now() - toggledAt < 50) return; toggledAt = performance.now(); onToggle(!on, shift) }
  return <div testId="pr-viewed-button" role="button" aria-label={on ? 'Mark as not viewed' : 'Mark as viewed'} tabIndex={0} onClick={e => flip(!!e.modifiers?.shift)} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') flip(false) }} style={{ ...row, gap: 6, height: 24, flexShrink: 0, paddingLeft: 6, paddingRight: 8, marginRight: 4, borderRadius: 8, backgroundColor: ink(t, .06), cursor: 'pointer', hover: { backgroundColor: ink(t, .1) } }}>
    <Checkbox tone="neutral" aria-label="Viewed" checked={on} onCheckedChange={(_, { shift }) => flip(shift)} />
    <Label color={t.text} size={12} lineHeight={16} weight={500}>Viewed</Label>
  </div>
}

const DirRow = memo(function DirRow({ row: r, onToggle }: { row: Extract<Row, { kind: 'dir' }>; onToggle: (key: string) => void }) {
  const t = useTheme()
  const flip = () => onToggle(r.key)
  return <Tip label={r.key} side="top" size={ROW_HEIGHT}>
    <div testId={`pr-dir-${r.key}`} role="button" aria-label={`${r.name}, ${r.open ? 'open' : 'closed'}`} aria-expanded={r.open} tabIndex={0} onClick={flip} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') flip() }} style={{ ...rowStyle, paddingLeft: 6 + r.depth * INDENT, hover: { backgroundColor: t.hover } }}>
      <Icon source={r.open ? N.chevronDown : N.chevronRight} size={12} color={t.textTertiary} />
      <Icon source={r.open ? N.folderOpen : N.folder} size={14} color={t.textSecondary} />
      <Label color={t.textSecondary} size={12.5} lineHeight={16} truncate style={{ flexGrow: 1 }}>{r.name}</Label>
    </div>
  </Tip>
})

const rowStyle = { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, height: ROW_HEIGHT, minWidth: 0, flexGrow: 1, paddingRight: 6, borderRadius: 7, cursor: 'pointer' } as const

const FileRow = memo(function FileRow({ row: r, index, tree, selected, state, draft, onSelect, onMark }: { row: Extract<Row, { kind: 'file' }>; index: number; tree: boolean; selected: boolean; state: ViewedState; draft: boolean; onSelect: (path: string) => void; onMark: (file: FileMeta, on: boolean, shift: boolean) => void }) {
  const t = useTheme()
  const f = r.file
  const dim = state === 'viewed'
  const kind = getFileIconName(f.path)
  const choose = () => onSelect(f.path)
  const toggledRef = useRef(0)
  const flip = (shift: boolean) => { if (performance.now() - toggledRef.current < 50) return; toggledRef.current = performance.now(); onMark(f, state !== 'viewed', shift) }
  return <Tip label={f.path} side="top" size={ROW_HEIGHT}>
    <div testId={`pr-file-${index}`} style={{ ...rowStyle, gap: 0, paddingRight: 0, backgroundColor: selected ? ink(t, .07) : 'transparent', hover: { backgroundColor: selected ? ink(t, .07) : t.hover } }}>
      <div role="button" aria-label={f.path} tabIndex={0} onClick={choose} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') choose() }} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexGrow: 1, minWidth: 0, height: ROW_HEIGHT, paddingLeft: tree ? 6 + r.depth * INDENT + 18 : 8 }}>
        <Icon source={diffFileIcons[kind] ?? diffFileIcons['code-brackets']!} size={14} color={dim ? t.textTertiary : kind === 'react' ? '#61dafb' : t.textSecondary} />
        <Label color={dim ? t.textTertiary : t.text} size={12.5} lineHeight={16} truncate style={{ flexShrink: 1 }}>{r.name}</Label>
        {r.dir && <Label color={t.textTertiary} size={11.5} lineHeight={16} truncate style={{ flexShrink: 6, maxWidth: 96 }}>{r.dir}</Label>}
        <div style={{ flexGrow: 1 }} />
        {state === 'changed' && <div testId={`pr-changed-${index}`} style={{ ...row, gap: 4, flexShrink: 0 }}><Dot color={t.link} /><Label color={t.link} size={11} lineHeight={14} weight={500}>Changed</Label></div>}
        {draft && <Label color={t.link} size={11} lineHeight={14} style={{ flexShrink: 0 }}>Draft</Label>}
        <div style={{ ...row, gap: 4, flexShrink: 0, minWidth: 56, justifyContent: 'flex-end' }}><Label color={t.green} size={12} lineHeight={16} style={num({ flexShrink: 0 })}>{`+${fmt(f.additions)}`}</Label><Label color={t.red} size={12} lineHeight={16} style={num({ flexShrink: 0 })}>{`−${fmt(f.deletions)}`}</Label></div>
      </div>
      <div onClick={e => flip(!!e.modifiers?.shift)} style={{ width: 26, height: ROW_HEIGHT, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
        <Checkbox testId={`pr-viewed-${index}`} tone="neutral" aria-label={`Viewed: ${f.path}`} checked={state === 'viewed'} onCheckedChange={(_, { shift }) => flip(shift)} />
      </div>
    </div>
  </Tip>
})
