import { useTreeSlot } from '../tree/Tree.tsx'
import { useTranscriptRowLease } from './Window.tsx'
import { InboundMessage, DelegatedResults } from './Messages.tsx'
// The user's message (`UserBubble` in `views/Transcript.tsx`): attachments and
// images above an 80%-wide bubble, inline skill/mention tokens, and a hover
// footer with the time, Copy and Save to note. Messages from other threads and
// delegated results are rows of their own (`views/delegations/ThreadMessageRows.tsx`),
// shown here in compact form.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { partToken } from '../../../../packages/kybern-client/src/composerTokens.ts'
import { agentResultItems, threadMessagePart } from '../../../../packages/kybern-client/src/delegations.ts'
import type { ContentPart } from '../../../../packages/kybern-client/src/types.ts'
import { clockTime } from './clock.ts'
import { Icon } from '../icons.tsx'
import { openSaveToNote } from '../notes/store.ts'
import { useApp } from '../state.ts'
import { useTheme } from '../ui.tsx'
import { Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { raisedFill, useGlass } from '../platform/glass.ts'
import { T } from './glyphs.ts'
import { ResponseImage } from './images.tsx'
import { AttachmentImage } from '../composer/AttachmentImage.tsx'
import { cachedMarkdownTheme, CODE, fg, META, muted, TEXT } from './kit.tsx'
import { FONT_MONO, FONT_UI } from '../theme.ts'
import { revealTransform, Rise } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { copyText, useRowState } from './store.ts'
import { SwapOnChange, useFresh } from './motion.tsx'
import { claimFlight, reportFlightTarget, useFlightHidden } from '../draft/store.ts'
import { observeElementBounds, type LayoutRect } from '../native/layout.ts'
import { TokenText, tokenSegments } from './InlineTokens.tsx'

/** `MessageActionButton` + `CopyAction`: a 2em square, copy glyph swapping to a
 *  green check for 1.4s through `IconSwap` (here the kit's `Swap`, 250 ms). */
export function CopyAction({ text, testId }: { text: string; testId?: string }) {
  const t = useTheme()
  const [copied, setCopied] = useState(false)
  useTranscriptRowLease(copied)
  return (
    <IconButton
      testId={testId}
      label="Copy message"
      icon={T.copy}
      size="sm"
      disabled={!text}
      onClick={() => {
        copyText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
    >
      <SwapOnChange kind="icon" active={copied ? 'check' : 'copy'}>
        <Icon source={copied ? T.check : T.copy} size={13.5} color={copied ? t.green : t.iconSecondary} style={{ pointerEvents: 'none' }} />
      </SwapOnChange>
    </IconButton>
  )
}

/** `SaveToNoteAction`: opens the shared "Save to note" picker (`notes/Overlays.tsx`) with this text. */
export function SaveToNoteAction({ text, testId }: { text: string; testId?: string }) {
  const threadId = useApp((s) => s.selectedId)
  const title = useApp((s) => s.open.thread?.title ?? '')
  const enabled = !!text && !!threadId
  return <IconButton testId={testId} label="Save to note" icon={T.note} glyph={13.5} size="sm" disabled={!enabled} onClick={() => openSaveToNote({ text, threadTitle: title, threadId: threadId! })} />
}

export function messageText(parts: ContentPart[]): string {
  let text = ''
  for (const p of parts) {
    if (p.type === 'text') text += p.text
    else if (p.type === 'image' || p.type === 'attachment' || p.type === 'system_row' || p.type === 'thread_message' || p.type === 'agent_results') continue
    else {
      const token = partToken(p)
      if (token) text += token
    }
  }
  return text
}

/** The footer's height: `pt-1` over a 24px action. */
const FOOTER_HEIGHT = 28

export const UserBubble = memo(function UserBubble({ parts, at, id, pending = false, clampLines }: { parts: ContentPart[]; at: string; /** The message id: an optimistic bubble keeps it when the daemon's copy replaces it. */ id?: string; pending?: boolean; clampLines?: number }) {
  const t = useTheme()
  const g = useGlass()
  const [hover, setHover] = useState(false)
  const renderer = useGpuixRequired()
  const body = useRef<PublicInstance | null>(null)
  const [expanded, setExpanded] = useRowState(`prompt:${at}`, false)
  const [overflowing, setOverflowing] = useState(false)
  // Decided once on mount: only a bubble sent just now plays the send animation.
  const fresh = useFresh(at)
  // The new chat's first message: a stand-in flies here from the composer (`draft/Morph.tsx`). This row mounts invisible at its
  // final place, reports where its text box and images are, and shows itself in the frame the stand-in lands.
  // Keyed by the message id when there is one: the new chat's bubble starts as a pending send and becomes the daemon's
  // block (a later `at`) mid-flight, under the same row.
  const flightKey = id ?? at
  const [flight] = useState(() => fresh && !pending && claimFlight(flightKey))
  const flightHidden = useFlightHidden(flightKey, flight)
  const fillNode = useRef<PublicInstance | null>(null)
  const fileNodes = useRef<(PublicInstance | null)[]>([])
  useEffect(() => {
    if (!flight) return
    const rects: { text: LayoutRect | null; images: (LayoutRect | null)[] } = { text: null, images: [] }
    const report = () => reportFlightTarget(flightKey, { text: rects.text, images: rects.images.filter((r): r is LayoutRect => !!r) })
    const stops = [
      ...(fillNode.current ? [observeElementBounds(renderer, { id: fillNode.current.id }, (e) => { rects.text = e.rect; report() })] : []),
      ...fileNodes.current.flatMap((node, i) => node ? [observeElementBounds(renderer, { id: node.id }, (e) => { rects.images[i] = e.rect; report() })] : []),
    ]
    return () => stops.forEach((stop) => stop())
  }, [flight, flightKey, renderer])
  const text = useMemo(() => messageText(parts), [parts])
  // Short one-line messages with `code` spans get chips like desktop's inline code.
  const chips = useMemo(() => {
    if (clampLines || text.length > 70 || text.includes('\n') || !/`[^`]+`/.test(text)) return null
    return text.split(/(`[^`]+`)/).filter(Boolean).map((seg) => seg.length > 2 && seg.startsWith('`') && seg.endsWith('`') ? { code: true, text: seg.slice(1, -1) } : { code: false, text: seg })
  }, [text, clampLines])
  const tokens = useMemo(() => (clampLines ? null : tokenSegments(parts)), [parts, clampLines])
  const plainText = useMemo(() => parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), [parts])
  useEffect(() => {
    if (!clampLines || expanded) return
    // One post-layout read, never per-frame measurement or polling.
    const timer = setTimeout(() => {
      if (!body.current) return
      const bounds = renderer.getElementBounds?.(body.current.id)
      if (bounds) setOverflowing(bounds.height >= TEXT.lineHeight * clampLines - 1)
    }, 30)
    return () => clearTimeout(timer)
  }, [text, clampLines, expanded, renderer])
  const inbound = threadMessagePart(parts)
  const results = agentResultItems(parts)
  const systemRow = parts.find((p): p is Extract<ContentPart, { type: 'system_row' }> => p.type === 'system_row')
  if (inbound) return <InboundMessage part={inbound} at={at} />
  if (results) return <DelegatedResults items={results} at={at} />
  const files = parts.filter((p): p is Extract<ContentPart, { type: 'image' | 'attachment' }> => p.type === 'image' || p.type === 'attachment')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {systemRow && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ height: 1, flexGrow: 1, backgroundColor: t.border }} />
          <Label color={muted(t, 0.7)} size={12}>
            {systemRow.text}
          </Label>
          <div style={{ height: 1, flexGrow: 1, backgroundColor: t.border }} />
        </div>
      )}
      {(text || files.length > 0) && (
        <Rise kind="send" play={fresh && !flight} paint={flight ? { initial: false, animate: { opacity: flightHidden ? 0 : 1 }, transition: { duration: 0 }, retain: true } : undefined} style={{ alignItems: 'flex-end', width: '100%' }}>
          <div
            testId="user-bubble"
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, maxWidth: '80%', position: 'relative', opacity: pending ? 0.7 : 1, paddingBottom: FOOTER_HEIGHT, marginBottom: -FOOTER_HEIGHT }}
          >
            {files.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, maxWidth: 240, marginBottom: 4 }}>
                {files.map((p, i) => flight ? (
                  // Only on the flight's row: a box per file, so its rect can be reported (the structure never changes after mount).
                  <div key={p.type === 'attachment' ? p.asset_id : i} ref={p.type === 'image' || p.media_type.startsWith('image/') ? (node) => { fileNodes.current[i] = node } : undefined} style={{ display: 'flex' }}>
                    {p.type === 'image' ? <ResponseImage source={`data:${p.media_type};base64,${p.data}`} label={`Attached image ${i + 1}`} thumbnail at={at} />
                      : p.media_type.startsWith('image/') ? <AttachmentImage assetId={p.asset_id} name={p.name} />
                      : <FileChip name={p.name} />}
                  </div>
                ) :
                  p.type === 'image' ? (
                    <ResponseImage key={i} source={`data:${p.media_type};base64,${p.data}`} label={`Attached image ${i + 1}`} thumbnail at={at} />
                  ) : p.media_type.startsWith('image/') ? (
                    <AttachmentImage key={p.asset_id} assetId={p.asset_id} name={p.name} />
                  ) : (
                    <FileChip key={i} name={p.name} />
                  ),
                )}
              </div>
            )}
            {text && (
              <div
                ref={flight ? (node) => { fillNode.current = node } : undefined}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  paddingLeft: 12,
                  paddingRight: 12,
                  paddingTop: 6,
                  paddingBottom: 6,
                  borderRadius: 12.8,
                  borderWidth: 1,
                  borderColor: 'rgba(0, 0, 0, 0)',
                  // Whole-window glass: the raised tint over the coat, not the composer's near-opaque fill.
                  backgroundColor: raisedFill(g, t.variant === 'dark' ? t.composer : 'rgba(255, 255, 255, 0.743)'),
                }}
              >
                {/* Plain text, not <markdown>: native markdown has no intrinsic width, and the
                    bubble must hug short messages (`w-max max-w-full`). */}
                <div style={{ display: 'flex', flexDirection: 'column', ...(clampLines && !expanded ? { maxHeight: TEXT.lineHeight * clampLines, overflow: 'hidden' as const } : {}) }}>
                  {tokens ? <TokenText segments={tokens} /> : chips ? (
                    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
                      {chips.map((seg, i) => seg.code
                        ? <div key={i} style={{ paddingLeft: 5.6, paddingRight: 5.6, marginLeft: 2, marginRight: 2, borderRadius: 6.4, backgroundColor: t.variant === 'dark' ? 'rgba(252, 252, 252, 0.09)' : 'rgba(13, 13, 13, 0.09)' }}>
                            <text style={{ color: t.text, fontSize: CODE.size, lineHeight: TEXT.lineHeight, fontFamily: FONT_MONO, userSelect: 'text' }}>{seg.text}</text>
                          </div>
                        : <text key={i} style={{ color: t.text, fontSize: TEXT.size, lineHeight: TEXT.lineHeight, fontFamily: FONT_UI, whiteSpace: 'nowrap', userSelect: 'text' }}>{seg.text}</text>)}
                    </div>
                  ) : <text ref={body} style={{ color: t.text, fontSize: TEXT.size, lineHeight: TEXT.lineHeight, fontFamily: FONT_UI, userSelect: 'text', ...(clampLines && !expanded ? { lineClamp: clampLines } : {}) }}>{text}</text>}
                </div>
              </div>
            )}
            {clampLines && (overflowing || expanded) && <Button variant="ghost" size="sm" testId="subagent-prompt-toggle" onClick={() => setExpanded(!expanded)} style={{ alignSelf: 'flex-start' }}>{expanded ? 'Show less' : 'Show full prompt'}</Button>}

            {/* Hover footer below the bubble (`absolute top-full right-0 pt-1`). The owner's own bounds
                reach down over it (`FOOTER_HEIGHT` padding, cancelled by the margin), so the pointer keeps
                hover while it travels onto Copy; hidden, it takes no pointer so it shows no hand. */}
            <div
              testId="user-footer"
              // Copy and Save fade in over 150 ms and out over 100 ms (opacity only: they sit under the text, no slide).
              paintTransform={revealTransform(hover, false)}
              style={{
                position: 'absolute',
                right: 2,
                bottom: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                paddingTop: 4,
                ...(PATCHED_NATIVE ? {} : { opacity: hover ? 1 : 0 }),
                ...(hover ? {} : { pointerEvents: 'none' as const }),
              }}
            >
              <Label color={muted(t, 0.45)} size={META.size} lineHeight={META.lineHeight}>
                {clockTime(at)}
              </Label>
              <CopyAction text={plainText || text} testId="user-copy" />
              <SaveToNoteAction text={plainText || text} testId="user-save-note" />
            </div>
          </div>
        </Rise>
      )}
    </div>
  )
})

/** A non-image attachment above the bubble. */
function FileChip({ name }: { name: string }) {
  const t = useTheme()
  const g = useGlass()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, maxWidth: 256, paddingLeft: 8, paddingRight: 8, borderRadius: 14, borderWidth: 1, borderColor: t.border, backgroundColor: raisedFill(g, t.composer) }}>
      <Icon source={T.file} size={14} color={t.text} />
      <Label color={t.text} size={13} weight={500} truncate>
        {name}
      </Label>
    </div>
  )
}

/** An inline bubble for a message sent mid-turn (`WorkRow` case "user"). */
export function MidTurnMessage({ parts, at }: { parts: ContentPart[]; at: string }) {
  // Inside a work group the stem runs past the message (`../tree`).
  const tree = useTreeSlot()
  return (
    <div paintTransform={tree.rise} style={{ position: 'relative', paddingTop: 12, paddingBottom: 16 }}>
      <UserBubble parts={parts} at={at} />
      {tree.lines}
    </div>
  )
}
