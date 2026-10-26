// The create/edit popover (`docs/specs/spaces.md` §7.6), anchored to the "+" tile or the space's
// tile: a live preview with the name, an image well, eight swatches and the icon grid.
import { useGpuixRequired, type EventPayload, type PublicInstance } from '@gpuix/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { RpcCallError } from '../../../../packages/kybern-client/src/client.ts'
import {
  SPACE_COLORS,
  SPACE_COPY,
  SPACE_ICONS,
  SPACE_LOGO_MAX_BYTES,
  SPACE_NAME_MAX,
  nextSpaceColor,
  spaceInitials,
} from '../../../../packages/kybern-client/src/spaces.ts'
import type { Space, SpaceColor, SpaceLogo as Logo } from '../../../../packages/kybern-client/src/types.ts'
import { popoverStyle, PopupLayer } from '../composer/Menu.tsx'
import { uploadPath } from '../composer/store.ts'
import { Icon } from '../icons.tsx'
import { Button } from '../kit/Button.tsx'
import { TextField } from '../kit/Field.tsx'
import { RADIUS } from '../kit/controls.ts'
import { Spinner } from '../kit/Spinner.tsx'
import { N } from '../nav/glyphs.ts'
import { getState } from '../state.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { SWATCHES } from './colors.ts'
import { switchSpace } from './current.ts'
import { SPACE_GLYPHS } from './glyphs.ts'
import { SpaceLogo } from './SpaceLogo.tsx'
import { createSpace, moveProjectToSpace, updateSpace, useSpaces } from './store.ts'
import { closeSpaceEditor, useSpaceUi } from './ui.ts'
import { isPrimary } from '../platform/keys.ts'

const EXTENSIONS: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

type Zone = 'name' | 'upload' | 'swatches' | 'grid' | 'cancel' | 'primary'
const ZONES: Zone[] = ['name', 'upload', 'swatches', 'grid', 'cancel', 'primary']
const GRID = 8

/** The logo the editor is holding: the stored one, a fresh upload (raw asset, shown from the file), or none. */
type Draft = { kind: 'initials' } | { kind: 'icon'; icon: string } | { kind: 'image'; assetId: string; preview: string | null }

const fromLogo = (logo: Logo): Draft => (logo.kind === 'image' ? { kind: 'image', assetId: logo.asset_id, preview: null } : logo)

const toLogo = (draft: Draft): Logo => (draft.kind === 'image' ? { kind: 'image', asset_id: draft.assetId } : draft)

const sameLogo = (a: Draft, b: Draft) => a.kind === b.kind && (a.kind !== 'icon' || a.icon === (b as typeof a).icon) && (a.kind !== 'image' || a.assetId === (b as typeof a).assetId)

function saveError(error: unknown): string {
  return error instanceof RpcCallError ? error.message : SPACE_COPY.saveFailure
}

export function SpaceEditor({ mode, space, still }: { mode: 'create' | 'edit'; space?: Space; still?: boolean }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const spaces = useSpaces((s) => s.spaces)
  const request = useSpaceUi((s) => s.editor)
  const stored = useMemo<Draft>(() => (space ? fromLogo(space.logo) : { kind: 'initials' }), [space])
  const [name, setName] = useState(space?.name ?? '')
  const [color, setColor] = useState<SpaceColor>(space?.color ?? nextSpaceColor(spaces))
  const [logo, setLogo] = useState<Draft>(stored)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [fileHover, setFileHover] = useState(false)
  const [zone, setZone] = useState<Zone>('name')
  const [gridIndex, setGridIndex] = useState(0)
  const root = useRef<PublicInstance | null>(null)
  const input = useRef<PublicInstance | null>(null)
  const trimmed = name.trim()
  const colorIndex = SPACE_COLORS.indexOf(color)

  const focusRoot = () => { if (root.current) renderer.focusElement?.(root.current.id) }
  const goto = (next: Zone) => {
    setZone(next)
    if (next === 'name') { if (input.current) renderer.focusElement?.(input.current.id) } else focusRoot()
  }

  const changed = mode === 'create' || trimmed !== space?.name || color !== space?.color || !sameLogo(logo, stored)
  const canSave = trimmed.length > 0 && !uploading && !saving && changed

  const pick = async (paths: readonly string[] | null | undefined) => {
    const path = paths?.[0]
    if (!path) return
    const media = EXTENSIONS[path.split('.').pop()?.toLowerCase() ?? '']
    const file = Bun.file(path)
    if (!media || file.size > SPACE_LOGO_MAX_BYTES) { setError(SPACE_COPY.imageError); return }
    setError(''); setUploading(true)
    try {
      const [bytes, asset] = await Promise.all([file.arrayBuffer(), uploadPath(path)])
      setLogo({ kind: 'image', assetId: asset.id, preview: `data:${media};base64,${Buffer.from(bytes).toString('base64')}` })
    } catch {
      setError(SPACE_COPY.uploadFailure)
    } finally {
      setUploading(false)
    }
  }
  const choose = async () => {
    if (uploading) return
    const paths = await renderer.promptForPaths?.({ files: true, multiple: false, prompt: 'Choose' })
    await pick(paths)
  }

  const submit = async () => {
    if (!canSave) return
    setSaving(true); setError('')
    try {
      if (mode === 'create') {
        const created = await createSpace(trimmed, color, toLogo(logo), { pop: !still })
        closeSpaceEditor()
        const project = request?.moveProject
        if (project) {
          const found = getState().projects.find((p) => p.id === project.id)
          if (found) await moveProjectToSpace(found, created, { undo: false })
        }
        switchSpace(created.id, 'pointer')
      } else if (space) {
        await updateSpace(space.id, {
          ...(trimmed !== space.name ? { name: trimmed } : {}),
          ...(color !== space.color ? { color } : {}),
          ...(!sameLogo(logo, stored) ? { logo: toLogo(logo) } : {}),
        })
        closeSpaceEditor()
      }
    } catch (e) {
      setError(saveError(e))
      setSaving(false)
    }
  }
  // Closing unmounts this editor, so `saving` is only cleared on failure.

  const onKey = (e: EventPayload) => {
    const key = e.key
    if (key === 'escape') { closeSpaceEditor(); return }
    if (key === 'enter' && isPrimary(e.modifiers)) { void submit(); return }
    if (key === 'tab') {
      const at = ZONES.indexOf(zone)
      goto(ZONES[(at + (e.modifiers?.shift ? ZONES.length - 1 : 1)) % ZONES.length]!)
      return
    }
    if (zone === 'swatches') {
      if (key === 'left' || key === 'right') setColor(SPACE_COLORS[(colorIndex + (key === 'right' ? 1 : SPACE_COLORS.length - 1)) % SPACE_COLORS.length]!)
      return
    }
    if (zone === 'grid') {
      const cells = SPACE_ICONS.length + 1
      const move = key === 'left' ? -1 : key === 'right' ? 1 : key === 'up' ? -GRID : key === 'down' ? GRID : 0
      if (move) setGridIndex((i) => Math.min(cells - 1, Math.max(0, i + move)))
      else if (key === 'enter' || key === 'space') chooseCell(gridIndex)
      return
    }
    if (key === 'enter' || key === 'space') {
      if (zone === 'upload') void choose()
      else if (zone === 'cancel') closeSpaceEditor()
      else if (zone === 'primary') void submit()
    }
  }
  const chooseCell = (index: number) => {
    setGridIndex(index)
    setLogo(index === 0 ? { kind: 'initials' } : { kind: 'icon', icon: SPACE_ICONS[index - 1]! })
  }
  const selectedCell = logo.kind === 'initials' ? 0 : logo.kind === 'icon' ? SPACE_ICONS.indexOf(logo.icon) + 1 : -1

  // The popover is positioned by the anchor; focus starts in the name.
  useEffect(() => { if (input.current) renderer.focusElement?.(input.current.id) }, [renderer])

  const preview = useMemo(() => ({ name, color, logo: toLogo(logo) }), [name, color, logo])
  const previewImage = logo.kind === 'image' ? logo.preview : null
  const focusRing = (on: boolean) => (on ? { borderWidth: 2, borderColor: t.composerFocusBorder } : {})
  const swatch = SWATCHES[color]
  const hasImage = logo.kind === 'image'

  return (
    <PopupLayer
      ref={root}
      testId="space-editor"
      side="right"
      align="start"
      sideOffset={8}
      still={still}
      tabIndex={0}
      onKeyDown={onKey}
      onMouseDownOutside={() => closeSpaceEditor()}
      style={{ ...popoverStyle(t), display: 'flex', flexDirection: 'column', width: 320, padding: 16, gap: 14 }}
    >
      <Label color={t.text} size={13} weight={600}>{mode === 'create' ? SPACE_COPY.editorNewTitle : SPACE_COPY.editorEditTitle}</Label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <SpaceLogo space={preview} size={44} previewImage={previewImage} />
        <div ref={input} style={{ display: 'flex', flexGrow: 1, minWidth: 0 }}>
          <TextField
            testId="space-name"
            autoFocus
            label={SPACE_COPY.nameLabel}
            placeholder={SPACE_COPY.namePlaceholder}
            value={name}
            width="100%"
            onChange={(value) => setName([...value].slice(0, SPACE_NAME_MAX).join(''))}
            onSubmit={() => void submit()}
            onFocus={() => setZone('name')}
            onKeyDown={onKey}
          />
        </div>
      </div>

      <div
        testId="space-image-well"
        onFileDragChange={(e) => setFileHover(!!e.hovered)}
        onFileDrop={(e) => { setFileHover(false); void pick(e.paths) }}
        style={{ display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <div
          onClick={() => void choose()}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 44, height: 44, borderRadius: 12, overflow: 'hidden', cursor: 'pointer',
            borderWidth: fileHover ? 1.5 : 1, borderColor: fileHover ? t.link : zone === 'upload' ? t.composerFocusBorder : t.border,
            backgroundColor: fileHover ? ink(t, 0.06) : ink(t, 0.03),
          }}
        >
          {uploading ? <Spinner size={14} color={t.textSecondary} />
            : hasImage && (previewImage || stored.kind === 'image') ? <SpaceLogo space={preview} size={44} previewImage={previewImage} />
            : <Icon source={N.imageUpload} size={18} color={fileHover ? t.link : t.textTertiary} style={{ pointerEvents: 'none' }} />}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flexGrow: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: -8 }}>
            <Button testId="space-upload" size="sm" onClick={() => void choose()}>{hasImage ? SPACE_COPY.replaceImage : SPACE_COPY.uploadImage}</Button>
            {hasImage && <Button testId="space-remove-image" variant="ghost" size="sm" onClick={() => setLogo({ kind: 'initials' })}>{SPACE_COPY.removeImage}</Button>}
          </div>
          <Label color={t.textSecondary} size={12}>{SPACE_COPY.imageHint}</Label>
        </div>
      </div>

      <div testId="space-swatches" style={{ display: 'flex', gap: 8, padding: 4, opacity: hasImage ? 0.5 : 1 }}>
        {SPACE_COLORS.map((c, i) => <Swatch key={c} color={c} on={c === color} focused={zone === 'swatches' && i === colorIndex} onPick={() => { setColor(c); setZone('swatches') }} />)}
      </div>

      <div testId="space-icons" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {Array.from({ length: Math.ceil((SPACE_ICONS.length + 1) / GRID) }, (_, row) => (
          <div key={row} style={{ display: 'flex', gap: 4 }}>
            {Array.from({ length: GRID }, (_, col) => row * GRID + col).filter((i) => i <= SPACE_ICONS.length).map((i) => (
              <Cell
                key={i}
                index={i}
                label={i === 0 ? (spaceInitials(name) || 'Aa') : null}
                glyph={i === 0 ? null : SPACE_GLYPHS[SPACE_ICONS[i - 1]!]!}
                selected={selectedCell === i}
                fill={swatch.fill}
                fg={swatch.fg}
                focused={zone === 'grid' && gridIndex === i}
                onPick={() => { setZone('grid'); chooseCell(i) }}
              />
            ))}
          </div>
        ))}
      </div>

      {error && <div testId="space-editor-error"><Label color={t.red} size={12} lineHeight={16}>{error}</Label></div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <div style={{ display: 'flex', borderRadius: RADIUS.lg, ...focusRing(zone === 'cancel') }}>
          <Button testId="space-cancel" onClick={() => closeSpaceEditor()}>{SPACE_COPY.cancel}</Button>
        </div>
        <div style={{ display: 'flex', borderRadius: RADIUS.lg, ...focusRing(zone === 'primary') }}>
          <Button variant="primary" kbd="⌘↵" testId="space-save" disabled={!canSave} onClick={() => void submit()}>{mode === 'create' ? SPACE_COPY.create : SPACE_COPY.save}</Button>
        </div>
      </div>
    </PopupLayer>
  )
}

/** One 20 px swatch; the chosen one wears a 2 px ring 2 px off its edge. */
function Swatch({ color, on, focused, onPick }: { color: SpaceColor; on: boolean; focused: boolean; onPick: () => void }) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  return (
    <div
      testId={`space-swatch-${color}`}
      role="button"
      aria-label={color}
      aria-pressed={on}
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', width: 20, height: 20, borderRadius: 10, backgroundColor: SWATCHES[color].fill, cursor: 'pointer' }}
    >
      {(on || hover || focused) && (
        <div style={{ position: 'absolute', left: -4, top: -4, width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: focused ? t.composerFocusBorder : on ? t.text : ink(t, 0.3), pointerEvents: 'none' }} />
      )}
    </div>
  )
}

/** One 32 px cell of the icon grid; the chosen one previews the tile (swatch fill, swatch foreground). */
function Cell({ index, label, glyph, selected, fill, fg, focused, onPick }: { index: number; label: string | null; glyph: string | null; selected: boolean; fill: string; fg: string; focused: boolean; onPick: () => void }) {
  const t = useTheme()
  return (
    <div
      testId={`space-icon-${index}`}
      role="button"
      aria-label={label ?? SPACE_ICONS[index - 1]}
      aria-pressed={selected}
      onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, cursor: 'pointer',
        ...(selected ? { backgroundColor: fill } : { hover: { backgroundColor: ink(t, 0.06) } }),
        ...(focused ? { borderWidth: 2, borderColor: t.composerFocusBorder } : {}),
      }}
    >
      {glyph ? <Icon source={glyph} size={18} color={selected ? fg : ink(t, 0.62)} /> : <Label color={selected ? fg : ink(t, 0.62)} size={13} weight={600}>{label ?? ''}</Label>}
    </div>
  )
}
