import { DocumentMarkdown } from '../native/markdownDocument.tsx'
import { VirtualCode, type SyntaxDocument } from '../native/syntax.tsx'
import { acquireSyntax, cachedRead, peekSyntax, rememberRead } from './fileCache.ts'
import { adoptRead, bufferKey, EDITABLE_BYTES, getBuffer, keepMine, openBuffer, readFile, releaseBuffer, reloadBuffer, saveBuffer, useBufferState, type FileRoot } from './fileBuffers.ts'
import { FileEditor, type FileEditorHandle } from './FileEditor.tsx'
import { defaultEditor, installedEditors, openInEditor, type Editor } from './editors.ts'
import { setWrapLines, useWrapLines } from './filePrefs.ts'
import { DocumentKeys, type DocumentKey } from '../tabs/hidden.ts'
import { isWindowVisible } from '../native/visibility.ts'
import { toast } from '../shell/toasts.tsx'
import { activeEnvironment } from '../shell/environment.ts'
import { useGpuix, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { spawn } from 'node:child_process'
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, FilesReadResult } from '../../../../packages/kybern-client/src/types.ts'

import { ISLAND } from '../MatrixLoader.tsx'
import { errorText } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuCheckboxItem, MenuItem, MenuLabel, MenuSeparator } from '../nav/overlay.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { Button } from '../kit/Button.tsx'
import { getClient, useApp } from '../state.ts'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { copyText } from '../transcript/store.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { Rise } from '../motion/kit.tsx'
import { LoadingLines } from './loading.tsx'
import { takeExplorerSelection, useExplorerSelection } from './explorerSelection.ts'
import { openTab } from '../tabs/open.ts'
import { DockEmpty, ErrorLine } from './parts.tsx'
import { MotionFileTreeRows, type TreeRow } from './MotionFileTree.tsx'
import { TREE_ROW_HEIGHT, TREE_WINDOW_THRESHOLD, treeWindowRange } from './fileTreeMotion.ts'

type Listing = FileEntry[] | 'loading' | 'error'
// Reuse the native row geometry/input path used by the PR viewports. Paint,
// hit testing and selection are rebuilt at the current scroll offset.
const EXPLORER_SCROLL_LAYOUT = { cacheLayout: true, cache: 'fill' as const }
export function Explorer({ projectId, width }: { projectId: string; width: number }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const tree = useRef<PublicInstance | null>(null)
  const treeList = useRef<PublicInstance | null>(null)
  const [focus, setFocus] = useState(0)
  const [treeWindow, setTreeWindow] = useState({ start: 0, end: 128 })
  const typeAhead = useRef({ value: '', at: 0 })
  const [listings, setListings] = useState<Record<string, Listing>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<string[] | null>(null)
  const selectionRequest = useExplorerSelection(), threadId = useApp(s => s.selectedId)
  const reveal = useRef<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
  const requested = useRef(new Set<string>())
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const load = useCallback((dir: string, retry = false) => {
    if (!retry && requested.current.has(dir)) return
    requested.current.add(dir)
    setListings((previous) => ({ ...previous, [dir]: 'loading' }))
    void getClient()!.call('files.list', { project_id: projectId, path: dir }).then((result) => {
      if (live.current) setListings((previous) => ({ ...previous, [dir]: result.entries }))
    }, (e) => {
      if (live.current) { setError(errorText(e)); setListings((previous) => ({ ...previous, [dir]: 'error' })) }
    })
  }, [projectId])
  useEffect(() => { load('') }, [load])
  useEffect(() => {
    if (!selectionRequest || !threadId) return
    const request = takeExplorerSelection(threadId, projectId)
    if (!request) return
    setQuery(''); setSelected(request.path); reveal.current = request.path
    setExpanded(previous => new Set([...previous, ...request.ancestors]))
    request.ancestors.forEach(dir => load(dir))
  }, [selectionRequest, threadId, projectId, load])
  useEffect(() => {
    let current = true
    if (!query.trim()) { setResults(null); return }
    const timer = setTimeout(() => {
      void getClient()!.call('files.search', { project_id: projectId, query: query.trim(), limit: 80 }).then((result) => { if (current) setResults(result.files) }, (e) => { if (current) setError(errorText(e)) })
    }, 200)
    return () => { current = false; clearTimeout(timer) }
  }, [query, projectId])
  const rows = useMemo(() => {
    if (results) return results.map((path, index): TreeRow => ({ key: path, path, name: path, kind: 'file', depth: 0, position: index + 1, setSize: results.length }))
    const out: TreeRow[] = []
    const append = (dir: string, depth: number) => {
      const listing = listings[dir]
      if (!Array.isArray(listing)) { out.push({ key: `${dir}:state`, path: dir, depth, kind: listing ?? 'loading', name: listing === 'error' ? 'Could not read folder · Retry' : 'Loading…', position: 1, setSize: 1 }); return }
      if (!listing.length) out.push({ key: `${dir}:empty`, path: dir, depth, kind: 'empty', name: 'Empty folder', position: 1, setSize: 1 })
      const sorted = [...listing].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
      for (const [index, file] of sorted.entries()) {
        out.push({ key: file.path, path: file.path, name: file.name, kind: file.kind, depth, position: index + 1, setSize: sorted.length })
        if (file.kind === 'directory' && expanded.has(file.path)) append(file.path, depth + 1)
      }
    }
    append('', 0)
    return out
  }, [listings, expanded, results])
  // Folders whose listing is still being read show a spinner in their chevron slot (after 150 ms).
  const loadingDirs = useMemo(() => new Set(Object.entries(listings).filter(([, value]) => value === 'loading').map(([dir]) => dir)), [listings])
  const virtualTree = rows.length > TREE_WINDOW_THRESHOLD
  const TreeHost = virtualTree ? 'virtual-list' : 'div'
  useEffect(() => { setTreeWindow({ start: 0, end: 128 }) }, [virtualTree, results])
  const scrollToRow = useCallback((index: number) => {
    const id = treeList.current?.id
    if (id == null) return
    if (virtualTree) { setTreeWindow(previous => treeWindowRange(rows.length, index, index + 1, previous)); renderer?.scrollToItem?.(id, index); return }
    const bounds = renderer?.getElementBounds?.(id), offset = renderer?.getScrollOffset?.(id)
    if (!bounds) return
    const top = -(offset?.[1] ?? 0), target = index * TREE_ROW_HEIGHT
    if (target < top) renderer?.scrollTo?.(id, 0, -target)
    else if (target + TREE_ROW_HEIGHT > top + bounds.height) renderer?.scrollTo?.(id, 0, -(target + TREE_ROW_HEIGHT - bounds.height))
  }, [renderer, virtualTree, rows.length])
  useEffect(() => {
    if (!reveal.current) return
    const index = rows.findIndex(row => row.path === reveal.current && row.kind === 'file')
    if (index < 0 || !treeList.current) return
    setFocus(index); scrollToRow(index); reveal.current = null
  }, [rows, scrollToRow])
  // A file opens as a tab of the thread (ADE-54): one click is the italic preview tab the next click replaces; a double click,
  // or Enter, keeps it.
  const activate = useCallback((row: TreeRow, keep = false) => {
    reveal.current = null
    if (row.kind === 'directory') {
      setExpanded((previous) => { const next = new Set(previous); if (next.has(row.path)) next.delete(row.path); else next.add(row.path); return next })
      load(row.path)
    } else if (row.kind === 'error') { setError(null); load(row.path, true) }
    else if (row.kind !== 'loading' && row.kind !== 'empty') {
      setSelected(row.path)
      if (threadId) openTab(threadId, { kind: 'file', path: row.path, root: 'project' }, { preview: !keep, focus: false })
    }
  }, [load, threadId])
  // How the last file was chosen: Enter/Space opens it without the pane entrance (keyboard actions are instant); a click plays it.
  const byKey = useRef(false)
  const activateRow = useCallback((row: TreeRow, index: number, clicks = 1) => {
    byKey.current = false
    setFocus(index); activate(row, clicks >= 2)
    if (tree.current) renderer?.focusElement?.(tree.current.id)
  }, [activate, renderer])
  // The dock keeps the tree only; files open as tabs beside the chat (ADE-54).
  return <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, position: 'relative' }}>
      {/* Never shrinks: a long tree squeezed this row until the field hung over the first rows (ADE-60). */}
      <div {...ISLAND} style={{ display: 'flex', width: '100%', height: 44, flexShrink: 0, alignItems: 'center', padding: 8 }}>
        <SearchField testId="dock-file-search" placeholder="Search files…" label="Search files" value={query} onChange={setQuery} width="100%" />
      </div>
      <ErrorLine error={error} />
      <div ref={tree} testId="dock-file-tree-focus" tabIndex={0} role="tree" aria-label="Project files" onKeyDown={event => {
        byKey.current = true
        const index = Math.min(focus, rows.length - 1), row = rows[index]
        if (!row || !event.key || event.modifiers?.cmd || event.modifiers?.ctrl || event.modifiers?.alt) return
        let next = index
        if (event.key === 'down') next = Math.min(rows.length - 1, index + 1)
        else if (event.key === 'up') next = Math.max(0, index - 1)
        else if (event.key === 'pagedown' || event.key === 'pageup') { const bounds = tree.current && renderer?.getElementBounds?.(tree.current.id); const page = Math.max(1, Math.floor((bounds?.height ?? 280) / TREE_ROW_HEIGHT)); next = Math.max(0, Math.min(rows.length - 1, index + (event.key === 'pagedown' ? page : -page))) }
        else if (event.key === 'home') next = 0
        else if (event.key === 'end') next = rows.length - 1
        else if (event.key === 'right') { if (row.kind === 'directory' && !expanded.has(row.path)) activate(row); else if (row.kind === 'directory') next = Math.min(rows.length - 1, index + 1) }
        else if (event.key === 'left') { if (row.kind === 'directory' && expanded.has(row.path)) activate(row); else { for (let i = index - 1; i >= 0; i--) if (rows[i]!.depth < row.depth) { next = i; break } } }
        else if (event.key === 'enter' || event.key === 'space') activate(row, true)
        else if (event.key.length === 1) {
          const now = Date.now(), previous = typeAhead.current
          const value = (now - previous.at < 700 ? previous.value : '') + event.key.toLocaleLowerCase()
          const prefix = [...value].every(char => char === value[0]) ? value[0]! : value
          typeAhead.current = { value, at: now }
          for (let step = 1; step <= rows.length; step++) { const i = (index + step) % rows.length; if (rows[i]!.name.toLocaleLowerCase().startsWith(prefix)) { next = i; break } }
        } else return
        setFocus(next)
        scrollToRow(next)
      }} style={{ display: 'flex', width: '100%', flexGrow: 1, minHeight: 0 }}>
      <TreeHost ref={treeList} testId="dock-file-tree" {...(virtualTree ? { ...EXPLORER_SCROLL_LAYOUT, estimatedItemHeight: TREE_ROW_HEIGHT, overdraw: 0, onVisibleRange: (event: { startIndex?: number; endIndex?: number }) => {
        setTreeWindow(previous => treeWindowRange(rows.length, event.startIndex ?? 0, event.endIndex ?? 0, previous))
      } } : {})} style={{ display: 'flex', flexDirection: 'column', width: '100%', flexGrow: 1, minHeight: 0, overflowY: virtualTree ? undefined : 'scroll', overflowX: 'hidden' }}>
        <MotionFileTreeRows rows={rows} open={expanded} loading={loadingDirs} selected={selected} focus={focus} virtual={virtualTree} window={virtualTree ? treeWindow : undefined} search={results !== null} activate={activateRow} />
      </TreeHost>
      </div>
    </div>
  </div>
}

/**
 * A file tab's body (ADE-54, editable since ADE-61): a project file (`projectId`, `files.read` / `files.write`) or a path a chat
 * names (`threadId`, `threads.files.*`, relative to the thread's folder). A text file up to 2 MB opens in the editor; larger,
 * truncated or binary files are read-only. `line` brings that line into view. The file is checked for changes on disk every
 * 2 s while the tab shows: a clean buffer follows it, a dirty one shows "Changed on disk." with Reload / Keep mine.
 */
export const FileViewer = memo(function FileViewer({ projectId, threadId, path, line, instant = false }: { projectId?: string; threadId?: string; path: string; line?: number; instant?: boolean }) {
  const t = useTheme()
  const owner = projectId ? `p:${projectId}` : `t:${threadId}`
  // Decided when the viewer mounts: the loaded file enters as `t-pane` unless it was opened from the keyboard or is cached.
  const [play] = useState(() => !instant && !cachedRead(owner, path))
  const markdownFile = /\.(md|mdx|markdown)$/i.test(path)
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const thread = useApp((s) => threadId ? s.threads.find((th) => th.id === threadId) : undefined)
  const absolutePath = path.startsWith('/') ? path : project ? `${project.path}/${path}` : thread ? `${thread.cwd}/${path}` : null
  const root = useMemo<FileRoot | null>(() => projectId ? { projectId } : threadId ? { threadId } : null, [projectId, threadId])
  const key = root ? bufferKey(root, path) : null
  // A file shown before (`fileCache.ts`) draws at once and is re-read behind it; an unchanged read keeps the same object, so its
  // syntax document is not rebuilt.
  const [file, setFile] = useState<FilesReadResult | null>(() => cachedRead(owner, path) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState(() => markdownFile && !line)
  const [reload, setReload] = useState(0)
  const editable = !!file && !file.binary && !file.truncated && file.size <= EDITABLE_BYTES
  const buffer = useBufferState(editable ? key : null)
  const editor = useRef<FileEditorHandle | null>(null)
  const wrap = useWrapLines()
  useEffect(() => {
    if (!root || !key) return
    let current = true
    setError(null)
    void readFile(root, path).then((result) => {
      if (!current) return
      const cached = cachedRead(owner, path)
      const same = cached && cached.content === result.content && cached.truncated === result.truncated && cached.binary === result.binary
      if (!same) rememberRead(owner, path, result)
      setFile(same ? cached : result)
      if (result.binary || result.truncated || result.size > EDITABLE_BYTES) return
      const before = getBuffer(key)
      openBuffer(root, path, result)
      if (before) { const shown = adoptRead(key, result); if (shown != null) editor.current?.replace(shown) }
    }, (e) => { if (current) setError(errorText(e)) })
    return () => { current = false }
  }, [owner, root, key, path, reload])
  // Changes on disk (an agent edited the file): a cheap version check every 2 s while this tab shows and the window is visible.
  useEffect(() => {
    if (!root || !key || !editable) return
    let current = true, busy = false
    const timer = setInterval(() => {
      const known = getBuffer(key)
      if (busy || !known || known.saving || !isWindowVisible()) return
      busy = true
      void readFile(root, path, known.version).then((result) => {
        if (!current || result.unchanged) return
        const shown = adoptRead(key, result)
        if (shown != null) { editor.current?.replace(shown); rememberRead(owner, path, result) }
      }, () => {}).finally(() => { busy = false })
    }, 2000)
    return () => { current = false; clearInterval(timer) }
  }, [root, key, editable, path, owner])
  // A clean buffer goes with its tab; unsaved edits stay until saved or discarded.
  useEffect(() => () => { if (key) releaseBuffer(key) }, [key])
  const save = useCallback(() => { if (key && editable) void saveBuffer(key) }, [key, editable])
  const editors = installedEditors()
  const preferred = defaultEditor()
  const openIn = useCallback((target: Editor | null) => {
    if (!target || !absolutePath || !activeEnvironment().local) return
    openInEditor(target, absolutePath, editor.current?.caretLine() ?? line ?? 1).catch((e: Error) => toast.error(e.message))
  }, [absolutePath, line])
  const canPreview = markdownFile && editable
  const showPreview = preview && canPreview
  const showPreviewRef = useRef(showPreview)
  showPreviewRef.current = showPreview
  // ⌘S saves, ⌘F finds, ⌘G / ⇧⌘G step through matches, ⌘⇧O opens the file in the default editor.
  const keys = useContext(DocumentKeys)
  useEffect(() => {
    if (!keys) return
    const handler = (event: DocumentKey) => {
      const m = event.modifiers
      if (!m?.cmd || m.ctrl || m.alt) return false
      if (event.key === 's' && !m.shift) { save(); return true }
      if (event.key === 'f' && !m.shift && editable && !showPreviewRef.current) { editor.current?.find(); return true }
      if (event.key === 'g') return editor.current?.findNext(!!m.shift) ?? false
      if (event.key === 'o' && m.shift) { openIn(defaultEditor()); return true }
      return false
    }
    keys.current = handler
    return () => { if (keys.current === handler) keys.current = null }
  }, [keys, save, openIn, editable])
  return <>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 36, paddingLeft: 10, paddingRight: 4, flexShrink: 0, borderBottomWidth: 0.6, borderColor: t.borderLight }}>
      <Label color={t.textSecondary} size={11} truncate style={{ flexGrow: 1 }}>{path.replaceAll('/', ' › ')}</Label>
      {(buffer?.saving || buffer?.dirty) && <div testId={buffer.saving ? 'file-saving' : 'file-unsaved'} style={{ display: 'flex', flexShrink: 0 }}><Label color={t.textTertiary} size={11}>{buffer.saving ? 'Saving…' : 'Unsaved'}</Label></div>}
      {canPreview && <Button size="sm" onClick={() => setPreview(!preview)}>{showPreview ? 'Source' : 'Preview'}</Button>}
      <Menu align="end" minWidth={220} testId="dock-file-actions" trigger={() => <IconButton icon={N.ellipsis} label="File actions" />}>
        <MenuItem id="save" label="Save" shortcut="⌘S" disabled={!buffer?.dirty || buffer.saving} onSelect={save} testId="file-action-save" />
        <MenuCheckboxItem id="wrap" label="Wrap lines" checked={wrap} onCheckedChange={setWrapLines} testId="file-action-wrap" />
        <MenuSeparator />
        {editors.length > 0 && absolutePath && activeEnvironment().local && <>
          <MenuLabel>Open in</MenuLabel>
          {editors.map((candidate) => <MenuItem key={candidate.id} id={`open-${candidate.id}`} label={candidate.name} shortcut={candidate.id === preferred?.id ? '⌘⇧O' : undefined} testId={`file-open-${candidate.id}`} onSelect={() => openIn(candidate)} />)}
          <MenuSeparator />
        </>}
        <MenuItem id="reveal" label="Reveal in Finder" icon={N.folder} disabled={!absolutePath || !activeEnvironment().local} onSelect={() => { if (absolutePath && activeEnvironment().local) spawn('open', ['-R', absolutePath], { stdio: 'ignore' }).on('error', () => {}) }} />
        <MenuSeparator />
        <MenuItem id="relative" label="Copy relative path" onSelect={() => copyText(path)} />
        <MenuItem id="absolute" label="Copy absolute path" disabled={!absolutePath} onSelect={() => { if (absolutePath) copyText(absolutePath) }} />
        <MenuItem id="contents" label="Copy contents" disabled={!file || file.binary} onSelect={() => { const text = key ? getBuffer(key)?.text : undefined; if (text != null) copyText(text); else if (file && !file.binary) copyText(file.content) }} />
      </Menu>
    </div>
    {buffer?.conflict && <div testId="file-conflict" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, paddingLeft: 12, paddingRight: 8, flexShrink: 0, backgroundColor: t.variant === 'dark' ? 'rgba(255, 186, 73, 0.10)' : 'rgba(186, 120, 0, 0.08)', borderBottomWidth: 0.6, borderColor: t.borderLight }}>
      <Label color={t.text} size={12} style={{ flexGrow: 1 }}>Changed on disk. Reload to see it, or keep your edits and save over it.</Label>
      <Button size="sm" testId="file-conflict-keep" onClick={() => { if (key) keepMine(key) }}>Keep mine</Button>
      <Button size="sm" variant="primary" testId="file-conflict-reload" onClick={() => { if (!key) return; const shown = reloadBuffer(key); if (shown != null) editor.current?.replace(shown) }}>Reload</Button>
    </div>}
    <ErrorLine error={error ?? buffer?.error ?? null} retry={error ? () => setReload((n) => n + 1) : undefined} />
    {file ? <Rise kind="pane" play={play} style={{ flexGrow: 1, minHeight: 0, minWidth: 0 }}>{file.binary ? <DockEmpty icon={N.note} title="Binary file" body="Open this file in your editor to view it." /> : <>
      {!editable && <ReadOnlyNote size={file.size} />}
      {showPreview && key ? <virtual-list testId="dock-file-content" {...EXPLORER_SCROLL_LAYOUT} overdraw={0} style={{ flexGrow: 1, minHeight: 0, overflowX: 'scroll' }}>
        <div style={{ padding: 12 }}><DocumentMarkdown source={getBuffer(key)?.text ?? file.content} theme={cachedMarkdownTheme(t)} /></div>
      </virtual-list> : editable && key && buffer ? <FileEditor key={key} bufferKey={key} path={path} wrap={wrap} line={line} handle={editor} />
        : <FileCode content={file.content} path={path} line={line} wrap={wrap} />}
    </>}</Rise> : !error && <LoadingLines testId="dock-file-loading" />}
  </>
})

/** Why a file opened read-only. */
function ReadOnlyNote({ size }: { size: number }) {
  const t = useTheme()
  const reason = size > EDITABLE_BYTES ? `This file is ${(Math.ceil(size / 1024 / 1024 * 10) / 10).toFixed(1)} MB, over the 2 MB the editor opens` : 'Only part of this file could be read'
  return <div testId="file-read-only" style={{ display: 'flex', alignItems: 'center', minHeight: 32, paddingLeft: 12, paddingRight: 12, flexShrink: 0, borderBottomWidth: 0.6, borderColor: t.borderLight }}>
    <Label color={t.textSecondary} size={12}>{`Read-only. ${reason}; open it in your editor to change it.`}</Label>
  </div>
}

// Share one whole-document parse across the bounded native rows.
export function FileCode({ content, path, line, wrap = false }: { content: string; path: string; line?: number; wrap?: boolean }) {
  const renderer = useGpuixRequired()
  // A document parsed for this text before (`fileCache.ts`) draws on the first render; otherwise it parses once and is kept.
  const [ready, setReady] = useState<{ content: string; path: string; document: SyntaxDocument } | null>(() => {
    const document = peekSyntax(renderer, path, content)
    return document ? { content, path, document } : null
  })
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    setError(null)
    const lease = acquireSyntax(renderer, path, content)
    void lease.pending.then(next => {
      if (live) setReady((prev) => prev?.document.id === next.id && prev.content === content && prev.path === path ? prev : { content, path, document: next })
    }, error => { if (live) setError(String(error)) })
    return () => { live = false; lease.release() }
  }, [renderer, content, path, retry])
  const document = ready?.content === content && ready.path === path ? ready.document : null
  const chunks = useMemo(() => document ? Array.from({ length: Math.ceil(document.lineCount / 64) }, (_, index) => ({
    start: index * 64, end: Math.min(document.lineCount, (index + 1) * 64),
  })) : [], [document])
  const sourceWidth = useMemo(() => content.split('\n').reduce((width, line) => Math.max(width, line.length * 7.3 + 60), 400), [content])
  const t = useTheme()
  // A link to `path:line` scrolls the line into view (three lines of context above it) and marks it.
  const list = useRef<PublicInstance | null>(null)
  useEffect(() => {
    if (!document || !line || !list.current) return
    const at = Math.max(0, line - 4)
    const id = list.current.id, item = Math.floor(at / 64), offset = (at % 64) * 20
    const native = renderer as { scrollToItem?: (id: number, index: number, offset?: number) => void; getListScrollTop?: (id: number) => number[] | null }
    // A scroll asked before the list has laid out its first rows is dropped, so it is asked again until the list sits on the line's chunk.
    let tries = 0
    const timer = setInterval(() => {
      native.scrollToItem?.(id, item, offset)
      if (native.getListScrollTop?.(id)?.[0] === item || ++tries >= 20) clearInterval(timer)
    }, 50)
    native.scrollToItem?.(id, item, offset)
    return () => clearInterval(timer)
  }, [document, line, renderer])
  if (error) return <ErrorLine error={error} retry={() => setRetry(n => n + 1)} />
  if (!document) return <LoadingLines testId="dock-source-loading" />
  // Wrapped, a chunk is as tall as its wrapped rows (the list measures it) and the native gutter keeps each number on its line.
  return <div testId="dock-file-horizontal" style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0, overflowX: wrap ? 'hidden' : 'scroll' }}><virtual-list key={wrap ? 'wrap' : 'scroll'} ref={list} testId="dock-file-content" {...EXPLORER_SCROLL_LAYOUT} estimatedItemHeight={1280} overdraw={0} style={{ flexGrow: 1, flexShrink: wrap ? 1 : 0, minHeight: 0, minWidth: 0, height: '100%', width: wrap ? '100%' : sourceWidth }}>
    {chunks.map(chunk => wrap
      ? <WrappedChunk key={chunk.start} document={document} start={chunk.start} end={chunk.end} />
      : <CodeChunk key={chunk.start} document={document} start={chunk.start} end={chunk.end} mark={line && line > chunk.start && line <= chunk.end ? line : undefined} />)}
  </virtual-list></div>
}
const WrappedChunk = memo(function WrappedChunk({ document, start, end }: { document: SyntaxDocument; start: number; end: number }) {
  const t = useTheme()
  return <div testId={`dock-code-chunk-${start}`} style={{ display: 'flex', width: '100%', minWidth: 0 }}>
    <VirtualCode document={document.id} revision={document.revision} startLine={start} endLine={end} showLineNumbers softWrap theme={cachedMarkdownTheme(t)} style={{ userSelect: 'text', flexGrow: 1, minWidth: 0, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 20 }} />
  </div>
})
const CodeChunk = memo(function CodeChunk({ document, start, end, mark }: { document: SyntaxDocument; start: number; end: number; mark?: number }) {
  const t = useTheme()
  return <div testId={`dock-code-chunk-${start}`} style={{ display: 'flex', height: (end - start) * 20, width: '100%', minWidth: 0, position: 'relative' }}>
    {mark !== undefined && <div testId="dock-code-line-mark" style={{ position: 'absolute', left: 0, right: 0, top: (mark - 1 - start) * 20, height: 20, backgroundColor: t.variant === 'dark' ? 'rgba(51, 134, 214, 0.14)' : 'rgba(1, 105, 204, 0.08)', pointerEvents: 'none' }} />}
    <text style={{ width: 44, flexShrink: 0, paddingRight: 10, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 20, color: t.textTertiary, textAlign: 'right', userSelect: 'none' }}>{Array.from({ length: end - start }, (_, i) => String(start + i + 1)).join('\n')}</text>
    <VirtualCode document={document.id} revision={document.revision} startLine={start} endLine={end} theme={cachedMarkdownTheme(t)} style={{ userSelect: 'text', flexGrow: 1, minWidth: 0, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 20 }} />
  </div>
})
