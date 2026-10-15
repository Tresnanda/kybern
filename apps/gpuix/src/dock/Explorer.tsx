import { createSyntaxDocument, releaseSyntaxDocument, VirtualCode, type SyntaxDocument } from '../native/syntax.tsx'
import { activeEnvironment } from '../shell/environment.ts'
import { useGpuix, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { spawn } from 'node:child_process'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, FilesReadResult } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { ISLAND } from '../MatrixLoader.tsx'
import { errorText } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { IconButton } from '../sidebar/rows.tsx'
import { getClient, useApp } from '../state.ts'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { copyText } from '../transcript/store.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { Action, DockEmpty, ErrorLine } from './parts.tsx'

type Listing = FileEntry[] | 'loading' | 'error'
type TreeRow = { key: string; path: string; name: string; kind: string; depth: number }
export function Explorer({ projectId, width }: { projectId: string; width: number }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const tree = useRef<PublicInstance | null>(null)
  const treeList = useRef<PublicInstance | null>(null)
  const [focus, setFocus] = useState(0)
  const typeAhead = useRef({ value: '', at: 0 })
  const [listings, setListings] = useState<Record<string, Listing>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<string[] | null>(null)
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
    let current = true
    if (!query.trim()) { setResults(null); return }
    const timer = setTimeout(() => {
      void getClient()!.call('files.search', { project_id: projectId, query: query.trim(), limit: 80 }).then((result) => { if (current) setResults(result.files) }, (e) => { if (current) setError(errorText(e)) })
    }, 200)
    return () => { current = false; clearTimeout(timer) }
  }, [query, projectId])
  const rows = useMemo(() => {
    if (results) return results.map((path): TreeRow => ({ key: path, path, name: path, kind: 'file', depth: 0 }))
    const out: TreeRow[] = []
    const append = (dir: string, depth: number) => {
      const listing = listings[dir]
      if (!Array.isArray(listing)) { out.push({ key: `${dir}:state`, path: dir, depth, kind: listing ?? 'loading', name: listing === 'error' ? 'Could not read folder · Retry' : 'Loading…' }); return }
      if (!listing.length) out.push({ key: `${dir}:empty`, path: dir, depth, kind: 'empty', name: 'Empty folder' })
      for (const file of [...listing].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))) {
        out.push({ key: file.path, path: file.path, name: file.name, kind: file.kind, depth })
        if (file.kind === 'directory' && expanded.has(file.path)) append(file.path, depth + 1)
      }
    }
    append('', 0)
    return out
  }, [listings, expanded, results])
  const activate = useCallback((row: TreeRow) => {
    if (row.kind === 'directory') {
      setExpanded((previous) => { const next = new Set(previous); if (next.has(row.path)) next.delete(row.path); else next.add(row.path); return next })
      load(row.path)
    } else if (row.kind === 'error') { setError(null); load(row.path, true) }
    else if (row.kind !== 'loading' && row.kind !== 'empty') setSelected(row.path)
  }, [load])
  return <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    <div style={{ display: 'flex', flexDirection: 'column', width: 240, flexShrink: 0, borderRightWidth: 0.6, borderColor: t.borderLight }}>
      <div {...ISLAND} style={{ display: 'flex', width: '100%', height: 44, alignItems: 'center', padding: 8 }}>
        <input testId="dock-file-search" placeholder="Search files…" aria-label="Search files" value={query} onChange={(e) => setQuery(e.value ?? '')} style={{ width: '100%', height: 28, paddingLeft: 8, paddingRight: 8, fontSize: 12, color: t.text, backgroundColor: t.buttonSecondary, borderRadius: 6 }} />
      </div>
      <ErrorLine error={error} />
      <div ref={tree} testId="dock-file-tree-focus" tabIndex={0} role="tree" aria-label="Project files" onKeyDown={event => {
        const index = Math.min(focus, rows.length - 1), row = rows[index]
        if (!row || !event.key || event.modifiers?.cmd || event.modifiers?.ctrl || event.modifiers?.alt) return
        let next = index
        if (event.key === 'down') next = Math.min(rows.length - 1, index + 1)
        else if (event.key === 'up') next = Math.max(0, index - 1)
        else if (event.key === 'pagedown' || event.key === 'pageup') { const bounds = tree.current && renderer?.getElementBounds?.(tree.current.id); const page = Math.max(1, Math.floor((bounds?.height ?? 280) / 28)); next = Math.max(0, Math.min(rows.length - 1, index + (event.key === 'pagedown' ? page : -page))) }
        else if (event.key === 'home') next = 0
        else if (event.key === 'end') next = rows.length - 1
        else if (event.key === 'right') { if (row.kind === 'directory' && !expanded.has(row.path)) activate(row); else if (row.kind === 'directory') next = Math.min(rows.length - 1, index + 1) }
        else if (event.key === 'left') { if (row.kind === 'directory' && expanded.has(row.path)) activate(row); else { for (let i = index - 1; i >= 0; i--) if (rows[i]!.depth < row.depth) { next = i; break } } }
        else if (event.key === 'enter' || event.key === 'space') activate(row)
        else if (event.key.length === 1) {
          const now = Date.now(), previous = typeAhead.current
          const value = (now - previous.at < 700 ? previous.value : '') + event.key.toLocaleLowerCase()
          const prefix = [...value].every(char => char === value[0]) ? value[0]! : value
          typeAhead.current = { value, at: now }
          for (let step = 1; step <= rows.length; step++) { const i = (index + step) % rows.length; if (rows[i]!.name.toLocaleLowerCase().startsWith(prefix)) { next = i; break } }
        } else return
        setFocus(next)
        if (tree.current) renderer?.scrollToItem?.(treeList.current!.id, next)
      }} style={{ display: 'flex', width: '100%', flexGrow: 1, minHeight: 0 }}>
      <virtual-list ref={treeList} testId="dock-file-tree" style={{ width: '100%', flexGrow: 1, minHeight: 0 }}>
        {rows.map((row, index) => <FileRow key={row.key} row={row} open={expanded.has(row.path)} selected={selected === row.path} focused={focus === index} activate={(row) => { setFocus(index); activate(row); if (tree.current) renderer?.focusElement?.(tree.current.id) }} />)}
      </virtual-list>
      </div>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 }}>
      {selected ? <FileViewer key={selected} projectId={projectId} path={selected} onClose={() => setSelected(null)} /> : <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}><Label color={t.textSecondary} size={12} style={{ opacity: 0.7, textAlign: 'center' }}>Select a file from the tree to view it.</Label></div>}
    </div>
  </div>
}

const FileRow = memo(function FileRow({ row, open, selected, focused, activate }: { row: TreeRow; open: boolean; selected: boolean; focused: boolean; activate: (row: TreeRow) => void }) {
  const t = useTheme()
  const folder = row.kind === 'directory'
  return <div style={{ paddingLeft: 6, paddingRight: 6 }}>
    <div role="treeitem" aria-expanded={folder ? open : undefined} aria-selected={selected} testId={`dock-file-${row.path || 'root'}`} onClick={() => activate(row)} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, paddingLeft: 6 + row.depth * 14, paddingRight: 6, borderRadius: 6, cursor: 'pointer', backgroundColor: focused ? t.selected : selected ? t.buttonSecondary : 'transparent', hover: { backgroundColor: focused ? t.selected : t.buttonSecondaryHover } }}>
      <Icon source={folder ? open ? N.folderOpen : N.folder : N.note} size={13} color={t.textSecondary} />
      <Label color={t.text} size={12} truncate>{row.name}</Label>
    </div>
  </div>
})

function FileViewer({ projectId, path, onClose }: { projectId: string; path: string; onClose: () => void }) {
  const t = useTheme()
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const absolutePath = project ? `${project.path}/${path}` : null
  const [file, setFile] = useState<FilesReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState(() => /\.(md|mdx|markdown)$/i.test(path))
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let current = true
    setError(null)
    void getClient()!.call('files.read', { project_id: projectId, path, max_bytes: 256 * 1024 }).then((result) => { if (current) setFile(result) }, (e) => { if (current) setError(errorText(e)) })
    return () => { current = false }
  }, [projectId, path, reload])
  const canPreview = /\.(md|mdx|markdown)$/i.test(path) && file && !file.binary && file.size <= 96 * 1024 && file.content.split('\n').length <= 2000
  const showPreview = preview && canPreview
  return <>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 36, paddingLeft: 10, paddingRight: 4, flexShrink: 0, borderBottomWidth: 0.6, borderColor: t.borderLight }}>
      <Label color={t.textSecondary} size={11} truncate style={{ flexGrow: 1 }}>{path.replaceAll('/', ' › ')}</Label>
      {canPreview && <Action onClick={() => setPreview(!preview)}>{showPreview ? 'Source' : 'Preview'}</Action>}
      <Menu align="end" minWidth={190} testId="dock-file-actions" trigger={() => <IconButton icon={N.ellipsis} size={28} label="File actions" />}>
        <MenuItem id="relative" label="Copy relative path" onSelect={() => copyText(path)} />
        <MenuItem id="absolute" label="Copy absolute path" disabled={!absolutePath} onSelect={() => { if (absolutePath) copyText(absolutePath) }} />
        <MenuItem id="contents" label="Copy contents" disabled={!file || file.binary} onSelect={() => { if (file && !file.binary) copyText(file.content) }} />
        <MenuItem id="reveal" label="Reveal in Finder" icon={N.folder} disabled={!absolutePath || !activeEnvironment().local} onSelect={() => { if (absolutePath && activeEnvironment().local) spawn('open', ['-R', absolutePath], { stdio: 'ignore' }).on('error', () => {}) }} />
      </Menu>
      <IconButton icon={N.x} size={28} label="Close file" onClick={onClose} testId="dock-file-close" />
    </div>
    <ErrorLine error={error} retry={() => setReload((n) => n + 1)} />
    {file ? file.binary ? <DockEmpty icon={N.note} title="Binary file" body="Open this file in your editor to view it." /> : <>
      {showPreview ? <div testId="dock-file-content" style={{ flexGrow: 1, minHeight: 0, overflow: 'scroll', padding: 12 }}>
        <markdown source={file.content} theme={cachedMarkdownTheme(t)} />
      </div> : <FileCode content={file.content} path={path} />}
      {file.truncated && <Label color={t.textSecondary} size={11} style={{ padding: 8 }}>Showing the first 256 KB. Open the file in your editor for the rest.</Label>}
    </> : !error && <Label color={t.textSecondary} size={12} style={{ padding: 12 }}>Loading file…</Label>}
  </>
}

// Share one whole-document parse across the bounded native rows.
export function FileCode({ content, path }: { content: string; path: string }) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState<{ content: string; path: string; document: SyntaxDocument } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    let document: SyntaxDocument | undefined
    setError(null)
    void createSyntaxDocument(renderer, { text: content, path }).then(next => {
      document = next
      if (live) setReady({ content, path, document: next })
      else releaseSyntaxDocument(renderer, next.id)
    }, error => { if (live) setError(String(error)) })
    return () => { live = false; if (document) releaseSyntaxDocument(renderer, document.id) }
  }, [renderer, content, path, retry])
  const document = ready?.content === content && ready.path === path ? ready.document : null
  const chunks = useMemo(() => document ? Array.from({ length: Math.ceil(document.lineCount / 64) }, (_, index) => ({
    start: index * 64, end: Math.min(document.lineCount, (index + 1) * 64),
  })) : [], [document])
  const sourceWidth = useMemo(() => content.split('\n').reduce((width, line) => Math.max(width, line.length * 7.3 + 60), 400), [content])
  const t = useTheme()
  if (error) return <ErrorLine error={error} retry={() => setRetry(n => n + 1)} />
  if (!document) return <Label color={t.textSecondary} size={12} style={{ padding: 12 }}>Loading source…</Label>
  return <div testId="dock-file-horizontal" style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0, overflowX: 'scroll' }}><virtual-list testId="dock-file-content" estimatedItemHeight={1280} overdraw={0} style={{ flexGrow: 1, flexShrink: 0, minHeight: 0, height: '100%', width: sourceWidth }}>
    {chunks.map(chunk => <CodeChunk key={chunk.start} document={document} start={chunk.start} end={chunk.end} />)}
  </virtual-list></div>
}
const CodeChunk = memo(function CodeChunk({ document, start, end }: { document: SyntaxDocument; start: number; end: number }) {
  const t = useTheme()
  return <div testId={`dock-code-chunk-${start}`} style={{ display: 'flex', height: (end - start) * 20, width: '100%', minWidth: 0 }}>
    <text style={{ width: 44, flexShrink: 0, paddingRight: 10, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 20, color: t.textTertiary, textAlign: 'right', userSelect: 'none' }}>{Array.from({ length: end - start }, (_, i) => String(start + i + 1)).join('\n')}</text>
    <VirtualCode document={document.id} revision={document.revision} startLine={start} endLine={end} theme={cachedMarkdownTheme(t)} style={{ flexGrow: 1, minWidth: 0, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 20 }} />
  </div>
})
