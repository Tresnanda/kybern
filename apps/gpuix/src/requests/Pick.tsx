// "Point for me" (`kybern_request_pick`, spec `cards/spec.md` §3): the agent asks the user to point at an element in the Preview or a
// visual, a file or folder, an image, or a window, and gets exact data back instead of a description.
//
// Element picks are a choice card (rows, a status line while the page waits, a confirm with a crop); a file, image or window is a
// closed form like `Secret.tsx`. All of them are built from the family's parts (`Card.tsx`). The overlay itself is drawn in the
// page (`pick/pickerScript.ts`); this card only starts it and follows it (`pick/controller.ts`).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { ChildProcess } from 'node:child_process'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { osLabels } from '../platform/os.ts'
import type { ApprovalRequest, FileEntry, PickRequestInput } from '../../../../packages/kybern-client/src/types.ts'
import { isElementPick, pickOverlayLabel, pickTitle } from '../../../../packages/kybern-client/src/pickRequest.ts'
import { Icon, ICONS } from '../icons.tsx'
import { G } from '../composer/glyphs.ts'
import { captureWindow, uploadImage, uploadImageFile, type UploadedImage } from './attach.ts'
import { clipboardAttachments } from '../composer/clipboard.ts'
import { DropHighlight } from '../motion/DropHighlight.tsx'
import { Button } from '../kit/Button.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { errorText } from '../nav/actions.ts'
import { callThread, ownProjectId, useApp } from '../state.ts'
import { FONT_MONO } from '../theme.ts'
import { respondApproval } from '../transcript/store.ts'
import { Label } from '../ui.tsx'
import { cancelTurn } from './actions.ts'
import { CancelLink, CardShell, HintText, Hints, Kbd, OptionList, OptionRow, RequestHeader, StatusRow, useCardTokens, Well } from './Card.tsx'
import { keyboardAnswer } from './Panel.tsx'
import { beginElementPick, declinePick, endPick, sendElementPick, stopElementPick } from '../pick/controller.ts'
import { forgetPickUi, patchPickUi, usePickUi } from '../pick/store.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { KYBERN_SCREEN_RECORDING, screenRecordingGranted } from '../pick/screenRecording.ts'
import { openSystemSettings, systemSettingsFailure } from '../settings/external.ts'
import { permissionTitle, permissionWaitingLine } from '../../../../packages/kybern-client/src/requestCards.ts'
import { agentFor } from './choices.tsx'
import { paneGlyph } from './glyphs.ts'
import { AppWell } from './Permission.tsx'
import { PhaseIn } from './summoned.tsx'
import { isPrimary } from '../platform/keys.ts'

const quote = (text: string) => `“${text}”`
const DECLINE = 'Decline'

export function PickRequestPanel({ approval, input, count }: { approval: ApprovalRequest; input: PickRequestInput; count: number }) {
  const badge = count > 1 ? `1 of ${count}` : undefined
  if (isElementPick(input.kind)) return <ElementPick approval={approval} input={input} badge={badge} />
  if (input.kind === 'file' || input.kind === 'folder') return <PathPick approval={approval} input={input} badge={badge} />
  if (input.kind === 'image') return <ImagePick approval={approval} input={input} badge={badge} />
  return <WindowPick approval={approval} input={input} badge={badge} />
}

// ---- parts ----

/** The rows give way to this while Kybern waits: a quiet box with what it waits for (spec: status line). */
function StatusLine({ glyph, spinner, label, trailing }: { glyph?: string; spinner?: boolean; label: string; trailing?: string }) {
  const k = useCardTokens()
  return (
    <div testId="pick-status" role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32, marginTop: 10, paddingLeft: 8, paddingRight: 10, borderRadius: 9, minWidth: 0, backgroundColor: k.c.ink(k.t.variant === 'light' ? 0.035 : 0.04) }}>
      {spinner ? <Spinner size={14} color={k.t.textSecondary} /> : glyph ? <Icon source={glyph} size={14} color={k.t.textSecondary} /> : null}
      <Label color={k.t.text} size={13} lineHeight={18} weight={500} truncate style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{label}</Label>
      {trailing && <Label color={k.t.textTertiary} size={12} lineHeight={16} style={{ flexShrink: 0 }}>{trailing}</Label>}
    </div>
  )
}

/** A quiet text action with its key: "Stop picking esc". */
function QuietAction({ label, keys, onClick, testId }: { label: string; keys?: string[]; onClick: () => void; testId: string }) {
  const k = useCardTokens()
  return (
    <div testId={testId} role="button" aria-label={label} tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onClick() }}
      style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, paddingLeft: 8, paddingRight: keys ? 6 : 8, borderRadius: 7, cursor: 'pointer', flexShrink: 0, hover: { backgroundColor: k.chipBg } }}>
      <Label color={k.t.textSecondary} size={12} lineHeight={16} weight={500}>{label}</Label>
      {keys && <Kbd keys={keys} />}
    </div>
  )
}

/** Label / value pairs, the label in a fixed column. Missing values are left out by the caller, never "unknown". */
function KeyValues({ rows }: { rows: { label: string; value: string; mono?: boolean }[] }) {
  const k = useCardTokens()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      {rows.map(row => (
        <div key={row.label} style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
          <Label color={k.t.textTertiary} size={12} lineHeight={18} style={{ width: 72, flexShrink: 0 }}>{row.label}</Label>
          <Label color={k.t.text} size={row.mono ? 11.5 : 12.5} lineHeight={18} font={row.mono ? FONT_MONO : undefined} truncate style={{ flexShrink: 1, minWidth: 0 }}>{row.value}</Label>
        </div>
      ))}
    </div>
  )
}

function Thumb({ src, width = 132, height = 60 }: { src: string; width?: number; height?: number }) {
  const k = useCardTokens()
  return (
    <div style={{ display: 'flex', width, height, flexShrink: 0, borderRadius: 7, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: k.c.ink(0.04), borderWidth: 1, borderColor: k.c.ink(0.08) }}>
      <img src={src} objectFit="contain" style={{ width, height }} />
    </div>
  )
}

const KEYS_HINT = (rows: number) => <><Kbd keys={['↑', '↓']} /><HintText>to move</HintText><HintText>·</HintText><Kbd keys={['1']} /><HintText>–</HintText><Kbd keys={[String(rows)]} /><HintText>or</HintText><Kbd keys={['↵']} /><HintText>to choose</HintText></>

// ---- element ----

function ElementPick({ approval, input, badge }: { approval: ApprovalRequest; input: PickRequestInput; badge?: string }) {
  const ui = usePickUi(approval.id)
  const source = input.kind === 'preview_element' ? 'preview' : 'visual'
  const where = source === 'preview' ? 'Preview' : 'visual'
  useEffect(() => () => { endPick(approval.id); forgetPickUi(approval.id) }, [approval.id])
  const confirming = ui.phase === 'confirm' || ui.phase === 'sending'
  const rows = confirming
    ? [{ label: 'Send this element', run: () => void sendElementPick(approval) }, { label: 'Pick again', run: () => void beginElementPick(approval, source, pickOverlayLabel(agentFor(approval))) }, { label: DECLINE, run: () => void declinePick(approval) }]
    : [{ label: source === 'preview' ? 'Pick in the Preview' : 'Pick in the visual', run: () => void beginElementPick(approval, source, pickOverlayLabel(agentFor(approval))) }, { label: DECLINE, run: () => void declinePick(approval) }]
  const highlight = Math.min(ui.highlight, rows.length - 1)
  const waiting = ui.phase === 'picking' || ui.phase === 'capturing'
  const choose = (index: number, keyboard: boolean) => { if (keyboard) keyboardAnswer(); patchPickUi(approval.id, { highlight: index }); rows[index]?.run() }
  const onKey = (e: { key?: string }) => {
    const key = e.key ?? ''
    if (ui.phase === 'sending') return true
    if (key === 'escape') { if (ui.phase === 'picking') stopElementPick(approval.id); else if (ui.phase !== 'capturing') cancelTurn(approval.thread_id); return true }
    if (waiting) return false
    if (/^[1-9]$/.test(key) && Number(key) <= rows.length) { choose(Number(key) - 1, true); return true }
    if (key === 'up' || key === 'down') { patchPickUi(approval.id, { highlight: (highlight + (key === 'down' ? 1 : -1) + rows.length) % rows.length }); return true }
    if (key === 'enter') { choose(highlight, true); return true }
    return false
  }
  const picked = ui.picked
  const facts = useMemo(() => {
    if (!picked) return []
    const { payload } = picked
    return [
      { label: 'Element', value: payload.selector, mono: true },
      ...(payload.id ? [{ label: 'Id', value: payload.id, mono: true }] : []),
      ...(payload.text ? [{ label: 'Text', value: quote(payload.text.slice(0, 80)) }] : []),
      ...(payload.page_url ? [{ label: 'Page', value: payload.page_url.replace(/^https?:\/\//, ''), mono: true }] : []),
    ]
  }, [picked])
  return (
    <CardShell testId="pick-panel" onKey={onKey}>
      <RequestHeader glyph={G.target} title={confirming ? `Send this element to ${agentFor(approval)}?` : pickTitle(input.kind, agentFor(approval))} chip={{ label: source === 'preview' ? 'Preview' : 'Visual' }} badge={badge} meta={confirming || !input.prompt ? undefined : quote(input.prompt)} />
      {confirming && picked && (
        <Well style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {picked.shot ? <Thumb src={picked.shot.dataUri} /> : null}
          <KeyValues rows={facts} />
        </Well>
      )}
      {waiting ? (
        <StatusLine glyph={ui.phase === 'picking' ? G.pointer : undefined} spinner={ui.phase === 'capturing'} label={ui.phase === 'picking' ? `Click the element in the ${where}` : 'Capturing the element…'} trailing={ui.phase === 'picking' ? '⌘ click selects the parent' : undefined} />
      ) : (
        <OptionList label={pickTitle(input.kind, agentFor(approval))}>
          {rows.map((row, i) => (
            <OptionRow key={row.label} n={i + 1} label={[{ text: row.label }]} testId={`pick-row-${i + 1}`} highlighted={highlight === i && (ui.phase !== 'sending' || i === 0)} dim={ui.phase === 'sending' && i !== 0} sending={ui.phase === 'sending' && i === 0} disabled={ui.phase === 'sending'} onClick={() => choose(i, false)} />
          ))}
        </OptionList>
      )}
      <Hints
        error={ui.error}
        left={ui.phase === 'picking' ? <HintText>{`Picking in the ${where}…`}</HintText> : ui.phase === 'capturing' ? <HintText>Cropping what you picked…</HintText> : ui.phase === 'sending' ? <HintText>Sending your choice…</HintText> : KEYS_HINT(rows.length)}
        right={ui.phase === 'picking' ? <QuietAction testId="pick-stop" label="Stop picking" keys={['esc']} onClick={() => stopElementPick(approval.id)} /> : waiting || ui.phase === 'sending' ? undefined : <CancelLink onClick={() => cancelTurn(approval.thread_id, false)} />}
      />
    </CardShell>
  )
}

// ---- file or folder ----

interface Row { entry: FileEntry; depth: number }

function PathPick({ approval, input, badge }: { approval: ApprovalRequest; input: PickRequestInput; badge?: string }) {
  const k = useCardTokens()
  const renderer = useGpuixRequired()
  const thread = useApp(s => s.threads.find(candidate => candidate.id === approval.thread_id))
  const projectId = thread && ownProjectId(thread)
  const folder = input.kind === 'folder'
  const [listings, setListings] = useState<Record<string, FileEntry[] | 'loading' | 'error'>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(folder ? '' : null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const asked = useRef(new Set<string>())

  const load = (dir: string) => {
    if (!projectId || asked.current.has(dir)) return
    asked.current.add(dir)
    setListings(previous => ({ ...previous, [dir]: 'loading' }))
    callThread(approval.thread_id, 'files.list', { project_id: projectId, path: dir }, thread?.machineId).then(
      result => setListings(previous => ({ ...previous, [dir]: result.entries })),
      () => setListings(previous => ({ ...previous, [dir]: 'error' })),
    )
  }
  useEffect(() => { load('') }, [projectId])
  useEffect(() => {
    const term = query.trim()
    if (!term || !projectId || folder) { setHits(null); return }
    let current = true
    const timer = setTimeout(() => { callThread(approval.thread_id, 'files.search', { project_id: projectId, query: term, limit: 60 }, thread?.machineId).then(result => { if (current) setHits(result.files) }, () => { if (current) setHits([]) }) }, 150)
    return () => { current = false; clearTimeout(timer) }
  }, [query, projectId, folder])

  const rows = useMemo<Row[]>(() => {
    const term = query.trim().toLowerCase()
    if (term && !folder) return (hits ?? []).map(path => ({ entry: { name: basename(path), path, kind: 'file' } as FileEntry, depth: 0 }))
    const out: Row[] = []
    const walk = (dir: string, depth: number) => {
      const list = listings[dir]
      if (!Array.isArray(list)) return
      const sorted = [...list].sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) || a.name.localeCompare(b.name))
      for (const entry of sorted) {
        const isDir = entry.kind === 'directory'
        if (term && folder && isDir && !entry.name.toLowerCase().includes(term) && !expanded.has(entry.path)) continue
        if (!isDir && folder) continue
        out.push({ entry, depth })
        if (isDir && expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk('', 0)
    return out
  }, [listings, expanded, query, hits, folder])

  const toggle = (entry: FileEntry) => {
    const open = expanded.has(entry.path)
    setExpanded(previous => { const next = new Set(previous); if (open) next.delete(entry.path); else next.add(entry.path); return next })
    if (!open) load(entry.path)
  }
  const click = (entry: FileEntry) => {
    if (entry.kind === 'directory') { toggle(entry); if (folder) setSelected(entry.path) } else if (!folder) setSelected(entry.path)
    setError('')
  }
  const send = async (path: string | null) => {
    if (path === null || busy) return
    setBusy(true); setError('')
    try { await respondApproval(approval.id, { decision: 'submit', response: { path: path || '.' } }) }
    catch (e) { setBusy(false); setError(errorText(e)) }
  }
  const chooseInFinder = async () => {
    const paths = await renderer.promptForPaths?.({ files: !folder, directories: folder, multiple: false, prompt: 'Choose' })
    const picked = paths?.[0]
    if (!picked) return
    const root = (thread?.cwd ?? '').replace(/[\\/]$/, '')
    const inside = root ? relative(root, picked) : null
    if (inside !== null && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) { void send(inside === '' ? '.' : inside.split(sep).join('/')); return }
    setError(`Choose something inside ${root ? basename(root) : 'this workspace'}, or decline and say where it is.`)
  }
  const label = selected === null ? null : selected === '' ? 'the workspace' : basename(selected)
  const header = pickTitle(input.kind, agentFor(approval))
  return (
    <CardShell testId="pick-panel" stealFocus={false}>
      <RequestHeader glyph={folder ? ICONS.folder : G.file} title={header} chip={thread?.cwd ? { label: thread.cwd.split('/').slice(-2).join('/'), mono: true } : undefined} badge={badge} meta={input.prompt ? quote(input.prompt) : undefined} />
      <Well style={{ gap: 6, paddingLeft: 6, paddingRight: 6 }}>
        <SearchField label={folder ? 'Filter folders' : 'Filter files'} testId="pick-filter" value={query} onChange={setQuery} placeholder={folder ? 'Filter folders' : 'Find a file'} autoFocus size="md" shell={{ height: 28 }}
          interceptKeys={['enter', 'escape']} onKeyDown={e => { if (e.key === 'enter') { e.preventDefault(); void send(selected) } }} />
        <div testId="pick-tree" role="tree" style={{ display: 'flex', flexDirection: 'column', maxHeight: 176, overflowY: 'scroll', minHeight: 0 }}>
          {folder && !query.trim() && (
            <TreeRow depth={0} name="This workspace" glyph={ICONS.folder} selected={selected === ''} onClick={() => { setSelected(''); setError('') }} />
          )}
          {rows.map(({ entry, depth }) => (
            <TreeRow key={entry.path} depth={depth + (folder && !query.trim() ? 1 : 0)} name={entry.name} glyph={entry.kind === 'directory' ? ICONS.folder : G.file} open={entry.kind === 'directory' ? expanded.has(entry.path) : undefined} selected={selected === entry.path} size={entry.kind === 'directory' ? undefined : entry.size ?? undefined} sub={query.trim() && !folder ? entry.path.slice(0, entry.path.length - entry.name.length).replace(/\/$/, '') : undefined} onClick={() => click(entry)} />
          ))}
          {!rows.length && <Label color={k.t.textTertiary} size={12} lineHeight={24} style={{ paddingLeft: 8 }}>{!projectId ? 'This chat has no project folder.' : listings[''] === 'loading' || listings[''] === undefined ? 'Loading…' : query.trim() ? 'No match' : 'Nothing here'}</Label>}
        </div>
      </Well>
      <Hints
        error={error}
        left={<HintText>{folder ? 'Click a folder to select it · type to filter' : 'Click a file to select it · type to filter'}</HintText>}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" testId="pick-finder" disabled={busy} onClick={() => void chooseInFinder()}>{osLabels().choose}</Button>
            <Button variant="ghost" size="sm" testId="pick-decline" disabled={busy} onKeyboard={keyboardAnswer} onClick={() => void declinePick(approval)}>{DECLINE}</Button>
            <Button variant="primary" size="sm" kbd="↵" testId="pick-send" busy={busy} disabled={busy || selected === null} onKeyboard={keyboardAnswer} onClick={() => void send(selected)}>{label ? `Send ${label.length > 22 ? `${label.slice(0, 21)}…` : label}` : 'Send'}</Button>
          </div>
        }
      />
    </CardShell>
  )
}

function TreeRow({ depth, name, glyph, open, selected, size, sub, onClick }: { depth: number; name: string; glyph: string; open?: boolean; selected: boolean; size?: number; sub?: string; onClick: () => void }) {
  const k = useCardTokens()
  return (
    <div testId="pick-tree-row" role="treeitem" aria-selected={selected} aria-expanded={open} onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 24, flexShrink: 0, paddingLeft: 6 + depth * 14, paddingRight: 8, borderRadius: 7, cursor: 'pointer', backgroundColor: selected ? k.highlight : 'rgba(0, 0, 0, 0)', ...(selected ? {} : { hover: { backgroundColor: k.hover } }) }}>
      <Icon source={glyph} size={14} color={selected ? k.highlightFg : k.t.textSecondary} style={{ pointerEvents: 'none' }} />
      <Label color={selected ? k.highlightFg : k.t.text} size={13} lineHeight={18} weight={selected ? 600 : 400} truncate style={{ flexShrink: 1, minWidth: 0 }}>{name}</Label>
      {sub && <Label color={k.t.textTertiary} size={11.5} lineHeight={16} truncate style={{ flexShrink: 2, minWidth: 0 }}>{sub}</Label>}
      <div style={{ flexGrow: 1 }} />
      {size !== undefined && <Label color={k.t.textTertiary} size={11.5} lineHeight={16} style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' } as never}>{formatSize(size)}</Label>}
    </div>
  )
}

const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

// ---- image ----

/** An uploaded file the card holds before it is sent. */
type Held = UploadedImage

function ImagePick({ approval, input, badge }: { approval: ApprovalRequest; input: PickRequestInput; badge?: string }) {
  const k = useCardTokens()
  const renderer = useGpuixRequired()
  const [over, setOver] = useState(false)
  const [held, setHeld] = useState<Held | null>(null)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const hold = async (name: string, mediaType: string, bytes: Uint8Array) => {
    setBusy(true); setError('')
    try { setHeld(await uploadImage(name, mediaType, bytes)) } catch (e) { setError(`Unable to attach that. ${errorText(e)}`) }
    finally { setBusy(false) }
  }
  const addPath = async (path: string) => {
    setBusy(true); setError('')
    try { setHeld(await uploadImageFile(path)) } catch (e) { setError(`Unable to attach that. ${errorText(e)}`) }
    finally { setBusy(false) }
  }
  const choose = async () => {
    const paths = await renderer.promptForPaths?.({ files: true, multiple: false, prompt: 'Choose' })
    if (paths?.[0]) await addPath(paths[0])
  }
  const send = async () => {
    if (!held || sending) return
    setSending(true); setError('')
    try { await respondApproval(approval.id, { decision: 'submit', response: { asset_id: held.assetId, name: held.name } }) }
    catch (e) { setSending(false); setError(errorText(e)) }
  }
  const paste = () => {
    try {
      const clip = clipboardAttachments(renderer)
      if (clip.paths[0]) { void addPath(clip.paths[0]); return true }
      if (clip.image) { void hold(clip.image.name ?? 'pasted-image.png', clip.image.mediaType, clip.image.data); return true }
    } catch (e) { setError(`Unable to paste. ${errorText(e)}`) }
    return false
  }
  return (
    <CardShell testId="pick-panel" stealFocus={false} onKey={e => (e.key === 'enter' && held ? (void send(), true) : false)}>
      <RequestHeader glyph={G.image} title={pickTitle('image', agentFor(approval))} badge={badge} meta={input.prompt ? quote(input.prompt) : undefined} />
      <div testId="pick-drop" onFileDragChange={e => setOver(!!e.hovered)} onFileDrop={e => { setOver(false); if (e.paths?.[0]) void addPath(e.paths[0]) }}
        style={{ position: 'relative', display: 'flex', flexDirection: held ? 'row' : 'column', alignItems: 'center', justifyContent: held ? 'flex-start' : 'center', gap: held ? 12 : 6, minHeight: 112, marginTop: 10, paddingLeft: 14, paddingRight: 14, borderRadius: 11, backgroundColor: over ? k.c.acc(0.10) : k.wellFill, borderWidth: 1.5, borderColor: over ? k.c.acc(0.7) : k.c.ink(0.12), borderStyle: held ? 'solid' : 'dashed' }}>
        <DropHighlight over={over} radius={11} color={k.c.acc(0.7)} width={1.5} />
        {held ? (
          <>
            {held.preview ? <Thumb src={held.preview} width={64} height={64} /> : <div style={{ display: 'flex', width: 64, height: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: k.chipBg }}><Icon source={G.file} size={22} color={k.t.textSecondary} /></div>}
            <KeyValues rows={[{ label: 'File', value: held.name }, { label: 'Size', value: formatSize(held.size) }]} />
          </>
        ) : busy ? <Spinner size={16} color={k.t.textSecondary} /> : (
          <>
            <Icon source={G.upload} size={18} color={over ? k.highlightFg : k.t.textSecondary} />
            <Label color={over ? k.highlightFg : k.t.text} size={13} lineHeight={18} weight={500}>{over ? 'Release to attach' : 'Drop the image here'}</Label>
            <Label color={k.t.textTertiary} size={12} lineHeight={16}>PNG, JPEG, HEIC or a PDF page</Label>
          </>
        )}
      </div>
      <Hints
        error={error}
        left={<><HintText>Drop, paste with</HintText><Kbd keys={['⌘', 'V']} /><HintText>or</HintText><QuietAction testId="pick-choose" label="Choose a file…" onClick={() => void choose()} />{<PasteListener onPaste={paste} />}</>}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" testId="pick-decline" disabled={sending} onKeyboard={keyboardAnswer} onClick={() => void declinePick(approval)}>{DECLINE}</Button>
            <Button variant="primary" size="sm" kbd="↵" testId="pick-send" busy={sending} disabled={!held || sending} onKeyboard={keyboardAnswer} onClick={() => void send()}>Send image</Button>
          </div>
        }
      />
    </CardShell>
  )
}

/** ⌘V anywhere in the window while the card shows pastes into it. */
function PasteListener({ onPaste }: { onPaste: () => boolean }) {
  const latest = useRef(onPaste)
  latest.current = onPaste
  useEffect(() => addWindowKeyHandler(e => e.key === 'v' && isPrimary(e.modifiers) && !e.modifiers?.alt && !e.modifiers?.shift ? latest.current() : false), [])
  return null
}

// ---- window ----

/**
 * Screen Recording is off for Kybern: the permission card's ask and wait phases come first (`Permission.tsx`, spec `cards/spec.md`
 * §6), drawn here because the grant is the client's, not the agent's app. Without it `screencapture` returns the desktop with no
 * windows. While waiting, Kybern checks every 2 s; "Capture anyway" covers macOS reporting the grant only after a restart.
 */
function ScreenRecordingStep({ approval, input, badge, onReady }: { approval: ApprovalRequest; input: PickRequestInput; badge?: string; onReady: (anyway: boolean) => void }) {
  const k = useCardTokens()
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const permission = KYBERN_SCREEN_RECORDING
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => { if (screenRecordingGranted() !== false) onReady(false) }, 2000)
    return () => clearInterval(timer)
  }, [waiting])
  const open = () => {
    setError('')
    openSystemSettings(permission.url).then(() => setWaiting(true), () => setError(systemSettingsFailure(permission.pane_label, ', then capture anyway')))
  }
  const asked = input.prompt ? ` ${agentFor(approval)} asked: ${quote(input.prompt)}` : ''
  return (
    <CardShell testId="pick-panel" stealFocus={false} onKey={e => (e.key === 'enter' ? (waiting ? onReady(true) : open(), true) : false)}>
      <RequestHeader glyph={ICONS.window} tileMark={<Icon source={paneGlyph(permission.pane)} size={14} color={k.t.text} />} title={permissionTitle(permission)} chip={{ label: 'macOS' }} badge={badge} error={error || undefined}
        meta={`Turn on Screen Recording to capture a window. Without it the capture holds no windows.${asked}`} />
      <PhaseIn phase={waiting ? 'wait' : 'ask'}>
        <AppWell input={permission} />
        {waiting && <StatusRow testId="pick-permission-status" label={permissionWaitingLine(permission)} />}
        <Hints
          left={<HintText>{waiting ? 'If macOS offers Quit & Reopen, this card is still here after.' : 'Kybern checks every 2 s once System Settings is open.'}</HintText>}
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <Button variant="ghost" size="sm" testId="pick-decline" onKeyboard={keyboardAnswer} onClick={() => void declinePick(approval)}>{DECLINE}</Button>
              {waiting
                ? <Button variant="secondary" size="sm" kbd="↵" testId="pick-capture-anyway" onClick={() => onReady(true)}>Capture anyway</Button>
                : <Button variant="primary" size="sm" kbd="↵" testId="pick-settings" onClick={open}>Open System Settings</Button>}
            </div>
          }
        />
      </PhaseIn>
    </CardShell>
  )
}

function WindowPick({ approval, input, badge }: { approval: ApprovalRequest; input: PickRequestInput; badge?: string }) {
  const k = useCardTokens()
  const [held, setHeld] = useState<{ assetId: string; preview: string; size: number } | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState(() => screenRecordingGranted() === false)
  // "Capture anyway": this process may only see the grant after a restart, while `screencapture` sees it at once.
  const unchecked = useRef(false)
  const child = useRef<ChildProcess | null>(null)
  useEffect(() => () => { child.current?.kill() }, [])

  const capture = () => {
    if (capturing) return
    if (!unchecked.current && screenRecordingGranted() === false) { setBlocked(true); return }
    setCapturing(true); setError('')
    captureWindow(proc => { child.current = proc }).then(async (bytes) => {
      if (!bytes) return
      const image = await uploadImage('window.png', 'image/png', bytes)
      setHeld({ assetId: image.assetId, preview: image.preview ?? '', size: image.size })
    }).catch(e => setError(`Unable to save the capture. ${errorText(e)} Try again, or decline and describe the window.`)).finally(() => setCapturing(false))
  }
  const send = async () => {
    if (!held || sending) return
    setSending(true); setError('')
    try { await respondApproval(approval.id, { decision: 'submit', response: { asset_id: held.assetId, name: 'window.png' } }) }
    catch (e) { setSending(false); setError(errorText(e)) }
  }
  if (blocked && !held) return <ScreenRecordingStep approval={approval} input={input} badge={badge} onReady={(anyway) => { unchecked.current = anyway; setBlocked(false) }} />
  return (
    <CardShell testId="pick-panel" stealFocus={false} onKey={e => (e.key === 'enter' ? (held ? void send() : capture(), true) : false)}>
      <RequestHeader glyph={ICONS.window} title={pickTitle('window', agentFor(approval))} chip={{ label: 'Screen Recording' }} badge={badge} meta={input.prompt ? quote(input.prompt) : undefined} />
      {held ? (
        <Well style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Thumb src={held.preview} width={132} height={80} />
          <KeyValues rows={[{ label: 'Capture', value: 'window.png' }, { label: 'Size', value: formatSize(held.size) }]} />
        </Well>
      ) : (
        <Well>
          <Label color={k.t.textSecondary} size={12.5} lineHeight={18}>{capturing ? 'Click a window to capture it, or press space and click, or drag an area. Esc cancels.' : 'Kybern opens the system capture: click a window, press space to switch between a window and an area.'}</Label>
        </Well>
      )}
      <Hints
        error={error}
        left={capturing ? <HintText>Waiting for the capture…</HintText> : <HintText>{`The picture goes to ${agentFor(approval)}, nothing else.`}</HintText>}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" testId="pick-decline" disabled={sending} onKeyboard={keyboardAnswer} onClick={() => void declinePick(approval)}>{DECLINE}</Button>
            {held && <Button variant="secondary" size="sm" testId="pick-recapture" disabled={sending || capturing} onClick={capture}>Capture again</Button>}
            {held
              ? <Button variant="primary" size="sm" kbd="↵" testId="pick-send" busy={sending} disabled={sending} onKeyboard={keyboardAnswer} onClick={() => void send()}>Send capture</Button>
              : <Button variant="primary" size="sm" kbd="↵" testId="pick-capture" busy={capturing} disabled={capturing} onKeyboard={keyboardAnswer} onClick={capture}>Capture a window</Button>}
          </div>
        }
      />
    </CardShell>
  )
}

