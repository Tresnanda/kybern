// The desktop's `views/AppUpdate.tsx` on GPUIX: the rail's update badge with its
// card (progress and retry stay in place), the once-per-version release
// announcement in the bottom-right corner, and the release details dialog.
// State and actions are `platform/update.ts`; copy and order match the desktop.
import { FencedMarkdown } from '../transcript/markdown.tsx'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWindowSize } from '@gpuix/react'
import type { PaintTransformProps } from '@gpuix/native/host'
import { ArrowRight01Icon, ArrowUpRight01Icon, Cancel01Icon, Download04Icon } from '@hugeicons/core-free-icons'
import { releasePresentation } from '@/lib/releaseNotes'
import { glyph, Icon } from '../icons.tsx'
import { Dialog, Tip, muted } from '../nav/overlay.tsx'
import { PopupLayer, surfaceShadow } from '../composer/Menu.tsx'
import { Spinner } from '../shell/Connection.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { openUrl } from '../pulls/PrStates.tsx'
import { ink, Label, LOGO_SVG, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { CARD, HarnessUpdateRow, idleKinds, UpdateCapsule, UpdateListRow, UpdateTile } from '../harnessUpdates/Rows.tsx'
import { MenuItem } from '../nav/overlay.tsx'
import { useControls } from '../kit/controls.ts'
import type { Theme } from '../theme.ts'
import { railName } from '../harnessUpdates/model.ts'
import { updateHarnesses, useUpdateRows } from '../harnessUpdates/store.ts'
import { canCheckForUpdates, closeUpdateDetails, dismissUpdateAnnouncement, installAppUpdate, manualUpdateText, openUpdateDetails, useAppUpdate } from './update.ts'
import { pressTransform } from '../motion/press.ts'
import { BLUR, EASE, SCALE } from '../motion/kit.tsx'
import { Presence } from '../motion/Presence.tsx'
import { frostBackdrop, frostFill, useGlass } from './glass.ts'
import { writeClipboardText } from './os.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { NOTIFICATION_INSET } from '../shell/toastPlacement.ts'

const ICON = { download: glyph(Download04Icon), arrowRight: glyph(ArrowRight01Icon), arrowUpRight: glyph(ArrowUpRight01Icon), x: glyph(Cancel01Icon) }

/**
 * `release-background.png` (AGENTS.md: the branded artwork), from the desktop's public folder or the app's Resources.
 * Off macOS copies pre-filtered near their drawn size (`sips -Z`): 420 px for the compact card (`release-artwork-card.jpg`),
 * 768 px for the dialog (`release-artwork.jpg`). The art is a fine dot grid and the renderer samples images bilinearly
 * without mipmaps, so the 2560 px original drawn into the 326 px card at 1x (8x smaller) showed heavy moire on Windows.
 * macOS draws at 2x from the original as before.
 */
const OFF_MAC_ARTWORK = { card: 'release-artwork-card.jpg', dialog: 'release-artwork.jpg' } as const
const artwork = (compact: boolean) => process.platform !== 'darwin' ? fileURLToPath(new URL(`../assets/${OFF_MAC_ARTWORK[compact ? 'card' : 'dialog']}`, import.meta.url)) : ARTWORK
const ARTWORK = (() => {
  const packaged = process.env.KYBERN_GPUIX_RESOURCES && path.join(process.env.KYBERN_GPUIX_RESOURCES, 'release-background.png')
  return packaged && existsSync(packaged) ? packaged : fileURLToPath(new URL('../../../../assets/release-background.png', import.meta.url))
})()

/** `--toast-open` 350 ms / `--toast-close` 250 ms, `--toast-ease`, 16px rise, scale `--scale-medium` and a 2px blur (motion.css:68-96). */
const TOAST_HIDDEN = { opacity: 0, translateY: 16, scale: SCALE.medium, blur: BLUR.small } as const
const TOAST_ENTER = (): PaintTransformProps | undefined => PATCHED_NATIVE && !REDUCED_MOTION
  ? { initial: TOAST_HIDDEN, animate: { opacity: 1, translateY: 0, scale: 1, blur: 0 }, transition: { duration: 0.35, ease: [...EASE.smoothOut] } }
  : undefined
const TOAST_EXIT = { to: TOAST_HIDDEN, duration: 0.25, ease: EASE.smoothOut } as const

function useUpdateLabel() {
  const phase = useAppUpdate(s => s.phase)
  const progress = useAppUpdate(s => s.progress)
  const errorKind = useAppUpdate(s => s.errorKind)
  // A deb or rpm install downloads the package for the user to install (`update.ts` `manualUpdate`).
  const manual = useAppUpdate(s => s.manual)
  const busy = phase === 'installing' || phase === 'checking'
  const label = manual ? 'Download update' : phase === 'installing' ? (progress === null ? 'Updating…' : `Updating… ${Math.round(progress * 100)}%`) : errorKind === 'install' ? 'Retry update' : 'Update and restart'
  return { busy, label, errorKind, manual }
}

function ReleaseArtwork({ compact = false }: { compact?: boolean }) {
  const size = useWindowSize({ intervalMs: 250 })
  // `h-36` compact, `h-[clamp(5rem,20vh,11rem)]` in the dialog.
  const height = compact ? 144 : Math.min(176, Math.max(80, size.height * 0.2))
  return <div style={{ display: 'flex', position: 'relative', alignItems: 'center', justifyContent: 'center', marginLeft: 12, marginRight: 12, marginTop: 12, height, flexShrink: 0, borderRadius: 16, overflow: 'hidden', pointerEvents: 'none' }}>
    <img src={artwork(compact)} objectFit="cover" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
    <svg source={LOGO_SVG} style={{ width: compact ? 76 : 96, height: (compact ? 76 : 96) * 315 / 504, color: '#ffffff', pointerEvents: 'none' }} />
  </div>
}

/** The round dark button over the artwork (`!size-8 !rounded-full !bg-black/35`). */
function ArtworkClose({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return <IconButton testId={testId} label={label} icon={ICON.x} size="lg" color="#ffffff" onClick={onClick} style={{ position: 'absolute', right: 20, top: 20, borderRadius: 16, backgroundColor: 'rgba(0, 0, 0, 0.35)', hover: { backgroundColor: 'rgba(0, 0, 0, 0.55)' }, active: { backgroundColor: 'rgba(0, 0, 0, 0.65)' } }} />
}

/** The card's depth without a border: a hairline ring of shadow, a close contact shadow and a soft ambient one. */
function cardShadow(t: Theme) {
  return t.variant === 'dark'
    ? [{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 0.5, color: 'rgba(255, 255, 255, 0.10)' }, { offsetX: 0, offsetY: 2, blurRadius: 6, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.24)' }, { offsetX: 0, offsetY: 12, blurRadius: 32, spreadRadius: -4, color: 'rgba(0, 0, 0, 0.40)' }]
    : [{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 0.5, color: 'rgba(0, 0, 0, 0.08)' }, { offsetX: 0, offsetY: 2, blurRadius: 6, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.05)' }, { offsetX: 0, offsetY: 12, blurRadius: 32, spreadRadius: -4, color: 'rgba(0, 0, 0, 0.14)' }]
}

/** "Update All" in the card's header: accent text, no fill until hover. */
function UpdateAllButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const t = useTheme()
  const c = useControls()
  return <div testId="harness-update-all" role="button" aria-label="Update All" aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
    onClick={() => { if (!disabled) onClick() }} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick() }}
    paintTransform={pressTransform(!disabled, 0.96, 0.15, 0.15)}
    style={{ display: 'flex', alignItems: 'center', height: 24, paddingLeft: 6, paddingRight: 6, borderRadius: 6, cursor: disabled ? 'default' : 'pointer', ...(disabled ? {} : { hover: { backgroundColor: c.acc(0.1) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }) }}>
    <Label color={disabled ? t.textTertiary : c.accentFg} size={13} lineHeight={18} weight={500} style={{ pointerEvents: 'none' }}>Update All</Label>
  </div>
}

/**
 * The app rail's update entry, above Settings, shown when a Kybern release is ready or a harness has a newer version.
 * Updating Kybern restarts it and the agents on this machine, so the badge opens a small card instead of installing on one
 * click; the card lists the Kybern update first, then a row per harness (`harnessUpdates/Rows.tsx`).
 */
export function RailUpdateButton() {
  const t = useTheme()
  const version = useAppUpdate(s => s.version)
  const { busy, label, errorKind, manual } = useUpdateLabel()
  const progress = useAppUpdate(s => s.progress)
  const { rows, starting } = useUpdateRows()
  const [open, setOpen] = useState(false)
  const pressedWhileOpen = useRef(false)
  const app = !!version && canCheckForUpdates()
  if (open && !app && rows.length === 0) setOpen(false)
  const name = railName(app ? version : null, rows)
  if (!name) return null
  const short = version?.replace(/^v/, '')
  const both = rows.length > 0
  const tip = both ? 'Updates available' : busy ? label : `Kybern v${short} is ready`
  const idle = idleKinds(rows, starting)
  // The capsule's word: Restart, or Download for a deb or rpm install, Retry after a failed install, the percent while installing.
  const capsuleText = busy ? (progress === null ? '' : `${Math.round(progress * 100)}%`) : manual ? 'Download' : errorKind === 'install' ? 'Retry' : 'Restart'
  return <div style={{ display: 'flex', position: 'relative' }}>
    <Tip label={tip} side="right" sideOffset={6} size={36} disabled={open}>
      <div testId="rail-update" role="button" aria-label={name}
        onMouseDown={() => { pressedWhileOpen.current = open }}
        onClick={() => { if (pressedWhileOpen.current) { pressedWhileOpen.current = false; return setOpen(false) } setOpen(true) }}
        paintTransform={pressTransform()}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, cursor: 'pointer', hover: { backgroundColor: ink(t, 0.06) } }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 14, backgroundColor: t.link, pointerEvents: 'none' }}>
          {app && busy ? <Spinner size={14} color="#ffffff" /> : <Icon source={ICON.download} size={16} color="#ffffff" />}
        </div>
      </div>
    </Tip>
    {open && <PopupLayer side="right" align="end" sideOffset={10} tabIndex={0} autoFocus testId="rail-update-card"
      onMouseDownOutside={() => setOpen(false)} onKeyDown={(e) => { if (e.key === 'escape') setOpen(false) }}
      style={{ display: 'flex', flexDirection: 'column', width: CARD.width, padding: CARD.padding, borderRadius: CARD.radius, backgroundColor: t.popover, boxShadow: cardShadow(t) }}>
      {(app ? 1 : 0) + rows.length > 1 && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 32, paddingLeft: 8, paddingRight: 4 }}>
        <Label color={t.text} size={13} lineHeight={18} weight={600}>Updates</Label>
        {rows.length > 1 && <UpdateAllButton disabled={idle.length === 0} onClick={() => void updateHarnesses(idle)} />}
      </div>}
      {app && <UpdateListRow testId="rail-update-app" label={`Kybern v${short} is ready`} name="Kybern"
        tile={<UpdateTile><svg source={LOGO_SVG} style={{ width: 18, height: 18 * 315 / 504, color: t.text, pointerEvents: 'none' }} /></UpdateTile>}
        tip={manual ? manualUpdateText(manual) : errorKind === 'install' ? 'The last update didn’t install. Try again, or see what’s new.' : 'Restarts Kybern and the agents running on this machine.'}
        onOpen={() => { setOpen(false); openUpdateDetails() }}
        capsule={<UpdateCapsule testId="rail-update-install" label={label} busy={busy} onClick={() => void installAppUpdate()}>{capsuleText}</UpdateCapsule>}
        menu={<MenuItem id="details" testId="rail-update-details-menu" label="See What’s New" onSelect={() => { setOpen(false); openUpdateDetails() }} />} />}
      {rows.map((row) => <HarnessUpdateRow key={row.kind} row={row} starting={starting} />)}
    </PopupLayer>}
  </div>
}

/** Infrequent update notices use the toast transition and never take focus. */
function UpdateAnnouncement({ version, notes, leaving, onGone }: { version: string; notes: string | null; leaving: boolean; onGone: () => void }) {
  const t = useTheme()
  const g = useGlass()
  const size = useWindowSize({ intervalMs: 250 })
  const release = useMemo(() => releasePresentation(version, notes), [version, notes])
  // The card enters and leaves by paint (`t-toast`: 16px, scale 0.97 and a 2px blur, 350 / 250 ms) with no layout per frame. Reduce
  // Motion shows it at once and fades it out over 100 ms (`Presence`).
  return <anchored position={{ x: size.width - NOTIFICATION_INSET, y: size.height - NOTIFICATION_INSET }} anchor="bottomRight" fit="snap" snapMargin={NOTIFICATION_INSET} deferred priority={5} occlude style={{ borderRadius: 24 }}>
    <Presence show={!leaving} enter={TOAST_ENTER()} exit={TOAST_EXIT} onGone={onGone} style={{ borderRadius: 24 }}>
    <div testId="update-announcement" aria-label="Kybern update available" backdrop={frostBackdrop(g, 'menus', 24)} style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: Math.min(352, size.width - 32), borderRadius: 24, borderWidth: 1, borderColor: g.on ? g.frostRim : t.border, backgroundColor: frostFill(g, 'menus', t.popover, 'frostMenu'), boxShadow: surfaceShadow(t), overflow: 'hidden' }}>
      <ReleaseArtwork compact />
      <ArtworkClose testId="update-announcement-dismiss" label="Dismiss update announcement" onClick={dismissUpdateAnnouncement} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 20 }}>
        <Label color={muted(t, 1)} size={12} weight={500}>{`New · v${version.replace(/^v/, '')}`}</Label>
        <Label color={t.text} size={18} lineHeight={24} weight={500}>{release.title}</Label>
        <Label color={muted(t, 1)} size={14} lineHeight={22} style={{ lineClamp: 3 }}>{release.summary}</Label>
        <Button testId="update-announcement-details" variant="ghost" iconAfter={ICON.arrowRight} onClick={openUpdateDetails} style={{ alignSelf: 'flex-start', marginTop: 8, marginLeft: -12 }}>See what’s new</Button>
      </div>
    </div>
    </Presence>
  </anchored>
}

/** A deb or rpm install updates with a command (`manualUpdate` in `update.ts`); this puts it on the clipboard. */
export function CopyUpdateCommand({ command, size, testId }: { command: string; size?: 'sm' | 'lg'; testId: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return <Button size={size} variant="secondary" testId={testId} onClick={() => void writeClipboardText(command).then(() => setCopied(true), () => {})}>{copied ? 'Copied' : 'Copy command'}</Button>
}

function UpdateDetails({ version, notes }: { version: string; notes: string | null }) {
  const t = useTheme()
  const size = useWindowSize({ intervalMs: 250 })
  const release = useMemo(() => releasePresentation(version, notes), [version, notes])
  const phase = useAppUpdate(s => s.phase)
  const progress = useAppUpdate(s => s.progress)
  const error = useAppUpdate(s => s.error)
  const { busy, label, manual } = useUpdateLabel()
  return <Dialog onClose={closeUpdateDetails} width={576} radius={24} testId="update-details">
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', maxHeight: size.height - 32, minHeight: 0 }}>
      <ReleaseArtwork />
      <ArtworkClose testId="update-details-close" label="Close release details" onClick={closeUpdateDetails} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 24, paddingRight: 24, paddingTop: 20, paddingBottom: 12, flexShrink: 0 }}>
        <Label color={muted(t, 1)} size={12} weight={500}>{`New · v${version.replace(/^v/, '')}`}</Label>
        <Label color={t.text} size={20} lineHeight={26} weight={500}>{release.title}</Label>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 24, paddingRight: 24, paddingBottom: 16, minHeight: 0, flexShrink: 1, overflowY: 'scroll' }}>
        {release.notes
          ? <FencedMarkdown source={release.notes} theme={cachedMarkdownTheme(t)} style={{ color: t.text, userSelect: 'text' }} />
          : <Label color={muted(t, 1)} size={14} lineHeight={22}>{release.summary}</Label>}
        <Button testId="update-details-notes" variant="ghost" iconAfter={ICON.arrowUpRight} onClick={() => openUrl(release.url)} style={{ alignSelf: 'flex-start', marginTop: 12, marginLeft: -12 }}>Read release notes</Button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 24, paddingRight: 24, paddingTop: 8, flexShrink: 0 }}>
        {phase === 'installing'
          ? <div testId="update-progress" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Label color={muted(t, 1)} size={12}>{progress === 1 ? 'Finishing installation…' : 'Downloading the update…'}</Label>
            {progress !== null && <div style={{ height: 4, borderRadius: 2, backgroundColor: ink(t, 0.12), overflow: 'hidden' }}><div style={{ width: `${Math.round(progress * 1000) / 10}%`, height: 4, backgroundColor: t.text }} /></div>}
          </div>
          : manual ? <Label color={muted(t, 1)} size={12} lineHeight={19} style={{ userSelect: 'text' }}>{manualUpdateText(manual)}</Label>
          : <Label color={muted(t, 1)} size={12} lineHeight={19}>Installing restarts Kybern and the agents running on this machine.</Label>}
        {error && <Label color={t.red} size={12} lineHeight={19}>{error}</Label>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingLeft: 24, paddingRight: 24, paddingTop: 16, paddingBottom: 20, flexShrink: 0 }}>
        <Button size="lg" variant="ghost" testId="update-details-later" onClick={closeUpdateDetails}>Later</Button>
        {manual?.command && phase !== 'installing' && <CopyUpdateCommand command={manual.command} size="lg" testId="update-details-copy" />}
        <Button size="lg" variant="primary" testId="update-details-install" disabled={busy} onClick={() => void installAppUpdate()}>{label}</Button>
      </div>
    </div>
  </Dialog>
}

/** App-wide updates stay independent of the selected project or connected daemon. */
export function AppUpdateSurface() {
  const version = useAppUpdate(s => s.version)
  const notes = useAppUpdate(s => s.notes)
  const announcementOpen = useAppUpdate(s => s.announcementOpen)
  const detailsOpen = useAppUpdate(s => s.detailsOpen)
  const showAnnouncement = !!version && announcementOpen && !detailsOpen
  // Keep the card mounted through its exit (AnimatePresence on the desktop).
  const [shown, setShown] = useState<{ version: string; notes: string | null } | null>(null)
  if (showAnnouncement && (shown?.version !== version || shown.notes !== notes)) setShown({ version: version!, notes })
  const gone = useCallback(() => setShown(null), [])
  return <>
    {shown && <AnnouncementPresence key={shown.version} version={shown.version} notes={shown.notes} visible={showAnnouncement} onGone={gone} />}
    {version && detailsOpen && <UpdateDetails version={version} notes={notes} />}
  </>
}

function AnnouncementPresence({ version, notes, visible, onGone }: { version: string; notes: string | null; visible: boolean; onGone: () => void }) {
  return <UpdateAnnouncement version={version} notes={notes} leaving={!visible} onGone={onGone} />
}
