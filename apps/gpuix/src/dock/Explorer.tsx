import { activeEnvironment } from '../shell/environment.ts'
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
    <div style={{ display: 'flex', flexDirection: 'column', width: width >= 560 ? 240 : 176, flexShrink: 0, borderRightWidth: 0.6, borderColor: t.borderLight }}>
      <div {...ISLAND} style={{ display: 'flex', width: '100%', height: 44, alignItems: 'center', padding: 8 }}>
        <input testId="dock-file-search" placeholder="Search files…" aria-label="Search files" value={query} onChange={(e) => setQuery(e.value ?? '')} style={{ width: '100%', height: 28, paddingLeft: 8, paddingRight: 8, fontSize: 12, color: t.text, backgroundColor: t.buttonSecondary, borderRadius: 6 }} />
      </div>
      <ErrorLine error={error} />
      <virtual-list testId="dock-file-tree" style={{ width: '100%', flexGrow: 1, minHeight: 0 }}>
        {rows.map((row) => <FileRow key={row.key} row={row} open={expanded.has(row.path)} selected={selected === row.path} activate={activate} />)}
      </virtual-list>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 }}>
      {selected ? <FileViewer key={selected} projectId={projectId} path={selected} onClose={() => setSelected(null)} /> : <DockEmpty icon={N.folder} title="Choose a file" body="Select a file from the tree to view it." />}
    </div>
  </div>
}

const FileRow = memo(function FileRow({ row, open, selected, activate }: { row: TreeRow; open: boolean; selected: boolean; activate: (row: TreeRow) => void }) {
  const t = useTheme()
  const folder = row.kind === 'directory'
  return <div style={{ paddingLeft: 6, paddingRight: 6 }}>
    <div role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') activate(row) }} testId={`dock-file-${row.path || 'root'}`} onClick={() => activate(row)} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, paddingLeft: 6 + row.depth * 14, paddingRight: 6, borderRadius: 6, cursor: 'pointer', backgroundColor: selected ? t.selected : 'transparent', hover: { backgroundColor: selected ? t.selected : t.buttonSecondaryHover } }}>
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

// GPUIX 0.10 eagerly lays out all lines in a native code node. Small fixed-height
// chunks keep natural scrolling and syntax highlighting while bounding layout.
// files.read has no offset/range support: keep one bounded read, released on close.
function FileCode({ content, path }: { content: string; path: string }) {
  const chunks = useMemo(() => {
    const lines = content.split('\n')
    return Array.from({ length: Math.ceil(lines.length / 64) }, (_, index) => ({
      start: index * 64,
      lines: lines.slice(index * 64, (index + 1) * 64),
    }))
  }, [content])
  return <virtual-list testId="dock-file-content" estimatedItemHeight={1280} overdraw={0} style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
    {chunks.map((chunk) => <CodeChunk key={chunk.start} path={path} start={chunk.start} lines={chunk.lines} />)}
  </virtual-list>
}

const CodeChunk = memo(function CodeChunk({ path, start, lines }: { path: string; start: number; lines: string[] }) {
  const t = useTheme()
  return <div testId={`dock-code-chunk-${start}`} style={{ display: 'flex', height: lines.length * 20, width: '100%', minWidth: 0 }}>
    <text style={{ width: 44, flexShrink: 0, paddingRight: 10, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 20, color: t.textTertiary, textAlign: 'right', userSelect: 'none' }}>{lines.map((_, i) => String(start + i + 1)).join('\n')}</text>
    <code code={lines.join('\n')} path={path} theme={cachedMarkdownTheme(t)} style={{ flexGrow: 1, minWidth: 0, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 20 }} />
  </div>
})
