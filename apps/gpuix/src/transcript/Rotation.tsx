// A Coordinator context refresh in the transcript (spec §10.1): a hairline row like "Setup started" with the label between
// the lines. While the old session writes its handoff it says "Refreshing context…" with a shimmer; it then settles in place
// ("Context refreshed · 14:02") with a chevron that opens the handoff card: the six sections, what Kybern carried, and, on the
// latest refresh, "Edit handoff". Motion is §10.4: arrival, the state swap, `Collapse` + `Chevron`, a read ↔ edit cross-fade
// and the "Edited by you" label. Words and handoff parsing are shared (`packages/kybern-client/src/rotation.ts`).
import { memo, useEffect, useMemo, useState } from 'react'
import { handoffEditable, handoffMissing, missingHandoffText, parseHandoff, ROTATION_COPY, rotationLabel, rotationMeta, type HandoffSection } from '../../../../packages/kybern-client/src/rotation.ts'
import { editHandoff, useLatestRotationId, type RotationBlock } from '../coordinator/rotation.ts'
import { Button } from '../kit/Button.tsx'
import { useControls } from '../kit/controls.ts'
import { TextArea } from '../kit/TextArea.tsx'
import { Collapse, enterTransform, fadeTransform, lineEnterTransform } from '../motion/kit.tsx'
import { N } from '../nav/glyphs.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { FONT_MONO, type Theme } from '../theme.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { clockTime } from './clock.ts'
import { cachedMarkdownTheme, Chevron, muted, Para } from './kit.tsx'
import { Shimmer, SwapOnChange, useFresh } from './motion.tsx'
import { useRowState } from './store.ts'
import { isPrimary } from '../platform/keys.ts'

const LABEL = { size: 12, lineHeight: 16 }
/** The card's section type (the mockup's `.sec-b`): 13px on a 19.5px line. */
const BODY = { size: 13, lineHeight: 19.5 }

type MarkdownTheme = ReturnType<typeof cachedMarkdownTheme>
const bodyThemes = new WeakMap<Theme, MarkdownTheme>()
/** The transcript's Markdown theme at the card's 13px, one stable object per theme. */
function bodyTheme(t: Theme): MarkdownTheme {
  const cached = bodyThemes.get(t)
  if (cached) return cached
  const base = cachedMarkdownTheme(t)
  const theme: MarkdownTheme = {
    ...base,
    markdown: { ...base.markdown, inlineCodeSizeRatio: 12 / BODY.size },
    metrics: { ...base.metrics, mdTextSize: BODY.size, mdLineHeight: BODY.lineHeight, mdBlockGap: 6 },
  }
  bodyThemes.set(t, theme)
  return theme
}

/** `latest` and `onSaveHandoff` stand in for the open thread and the daemon where there is neither (the verification fixture). */
export interface RotationRowProps {
  block: RotationBlock
  threadId: string
  latest?: boolean
  onSaveHandoff?: (text: string) => Promise<string | null>
}

export const RotationRow = memo(function RotationRow({ block, threadId, latest: latestGiven, onSaveHandoff }: RotationRowProps) {
  const t = useTheme()
  // Decided once on mount: only a row that just arrived plays its entrance.
  const fresh = useFresh(block.at)
  const [open, setOpen] = useRowState(`rotation:${block.id}`, false)
  const latestId = useLatestRotationId()
  const latest = latestGiven ?? latestId === block.id
  const [editedAtMount] = useState(block.edited)
  // One descriptor per mount: a new object on every render could restart the native entrance.
  const arrival = useMemo(() => fresh ? { left: lineEnterTransform([1, 0.5]), label: enterTransform('label'), right: lineEnterTransform([0, 0.5]) } : null, [fresh])
  const editedEnter = useMemo(() => editedAtMount ? undefined : enterTransform('meta'), [editedAtMount])
  const label = rotationLabel(block, clockTime(block.at))
  const toggle = () => { if (!block.pending) setOpen(!open) }
  return (
    <div testId={`rotation-${block.rotationId}`} style={{ display: 'flex', flexDirection: 'column', paddingTop: 8, paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div paintTransform={arrival?.left} style={{ height: 1, flexGrow: 1, backgroundColor: t.border }} />
        <div paintTransform={arrival?.label} style={{ display: 'flex', alignItems: 'center', flexShrink: 1, minWidth: 0 }}>
          <div
            testId={`rotation-toggle-${block.rotationId}`}
            role="button"
            tabIndex={block.pending ? -1 : 0}
            aria-label={label}
            aria-expanded={open}
            onClick={toggle}
            onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') toggle() }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 8, paddingTop: 3, paddingBottom: 3, borderRadius: 7, minWidth: 0, cursor: block.pending ? 'default' : 'pointer', ...(block.pending ? {} : { hover: { backgroundColor: t.hover } }) }}
          >
            {block.reason === 'harness_switch' && block.to && <ProviderMark kind={block.to.kind} size={11} />}
            <SwapOnChange kind="state" active={block.pending ? 'pending' : 'settled'} style={{ justifyContent: 'flex-start' }} innerStyle={{ minWidth: 0 }}>
              {block.pending
                ? <Shimmer text={label} color={muted(t)} size={LABEL.size} lineHeight={LABEL.lineHeight} />
                : <Label color={muted(t)} size={LABEL.size} lineHeight={LABEL.lineHeight} truncate style={{ hover: { color: t.text } }}>{label}</Label>}
            </SwapOnChange>
            {!block.pending && <Chevron open={open} size={12} color={muted(t, 0.7)} />}
          </div>
          {block.edited && (
            <div testId={`rotation-edited-${block.rotationId}`} paintTransform={editedEnter} style={{ display: 'flex', flexShrink: 0, paddingLeft: 4 }}>
              <Label color={t.textTertiary} size={11} lineHeight={16}>{ROTATION_COPY.edited}</Label>
            </div>
          )}
        </div>
        <div paintTransform={arrival?.right} style={{ height: 1, flexGrow: 1, backgroundColor: t.border }} />
      </div>
      <Collapse open={open && !block.pending} testId={`rotation-panel-${block.rotationId}`}>
        <HandoffCard block={block} threadId={threadId} latest={latest} onSave={onSaveHandoff} />
      </Collapse>
    </div>
  )
})

/** The opened row: the handoff in its sections (or why there is none), what was carried, and the edit flow. */
function HandoffCard({ block, threadId, latest, onSave }: { block: RotationBlock; threadId: string; latest: boolean; onSave?: (text: string) => Promise<string | null> }) {
  const t = useTheme()
  const c = useControls()
  const missing = handoffMissing(block)
  const sections = parseHandoff(block.handoff)
  const editable = latest && !missing && block.handoff != null
  const [editing, setEditing] = useState(false)
  const [switched, setSwitched] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const startEdit = () => { setDraft(block.handoff ?? ''); setError(''); setSwitched(true); setEditing(true) }
  const stopEdit = () => { setSwitched(true); setEditing(false); setError('') }
  const canSave = editing && !saving && handoffEditable(draft, block.handoff)
  const save = async () => {
    if (!canSave) return
    setSaving(true); setError('')
    const failure = await (onSave ?? ((text: string) => editHandoff(threadId, block.rotationId, text)))(draft.trim())
    setSaving(false)
    if (failure) setError(failure)
    else stopEdit()
  }
  // ⌘↵ saves from anywhere in the window while the editor is open, like the Coordinator brief card.
  useEffect(() => {
    if (!editing) return
    return addWindowKeyHandler((e) => {
      if (e.key !== 'enter' || !isPrimary(e.modifiers)) return false
      void save()
      return true
    })
  })
  return (
    <div testId={`rotation-card-${block.rotationId}`} style={{ display: 'flex', flexDirection: 'column', marginTop: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: t.border, backgroundColor: c.ink(t.variant === 'dark' ? 0.03 : 0.04) }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          <Label color={t.text} size={12} lineHeight={16} weight={500}>{missing ? ROTATION_COPY.noHandoff : ROTATION_COPY.handoff}</Label>
          <Para color={muted(t)} size={11.5} lineHeight={16} style={{ marginTop: 2 }}>{rotationMeta(block)}</Para>
        </div>
        {editable && <Button variant="ghost" size="sm" icon={N.pencil} testId="rotation-edit" disabled={editing} onClick={startEdit}>{ROTATION_COPY.edit}</Button>}
      </div>
      <div key={editing ? 'edit' : 'read'} paintTransform={switched ? fadeTransform() : undefined} style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
        {editing ? (
          <>
            <TextArea
              label="Handoff" testId="rotation-editor" value={draft} onChange={setDraft} autoFocus minRows={10} maxRows={22} disabled={saving}
              style={{ fontFamily: FONT_MONO, fontSize: 12.5, lineHeight: 19 }}
            />
            {error && <Para color={t.red} size={12} lineHeight={16} style={{ marginTop: 6 }}>{error}</Para>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <Para color={muted(t)} size={12} lineHeight={16} style={{ flexGrow: 1 }}>{ROTATION_COPY.editHint}</Para>
              <Button variant="ghost" size="sm" testId="rotation-cancel" disabled={saving} onClick={stopEdit}>{ROTATION_COPY.cancel}</Button>
              <Button variant="primary" size="sm" kbd="⌘↵" testId="rotation-save" busy={saving} disabled={!canSave} onClick={() => void save()}>{ROTATION_COPY.save}</Button>
            </div>
          </>
        ) : missing ? (
          <Para color={muted(t)} size={BODY.size} lineHeight={BODY.lineHeight} selectable>{missingHandoffText(block.handoffStatus)}</Para>
        ) : sections.length === 0 ? (
          <Para color={t.textTertiary} size={BODY.size} lineHeight={BODY.lineHeight}>None</Para>
        ) : (
          sections.map((section, i) => <Section key={`${i}:${section.heading}`} section={section} />)
        )}
      </div>
    </div>
  )
}

function Section({ section }: { section: HandoffSection }) {
  const t = useTheme()
  return (
    <div testId="rotation-section" style={{ display: 'flex', flexDirection: 'column' }}>
      {section.label && <Label color={muted(t)} size={11.5} lineHeight={16} weight={600} style={{ marginTop: 10, marginBottom: 2 }}>{section.label}</Label>}
      {section.none
        ? <Para color={t.textTertiary} size={BODY.size} lineHeight={BODY.lineHeight}>None</Para>
        : <markdown source={section.body} theme={bodyTheme(t)} style={{ color: t.text, userSelect: 'text' }} />}
    </div>
  )
}
