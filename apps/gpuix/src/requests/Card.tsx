// The parts of a request card (Direction B, "Option list"): the header, the wells that show what is being asked, the numbered
// rows and the hint line. Every request kind, approval or form, is built from these, so they read as one family.
// Spec and tokens: `.kybern-artifacts/ade-approval-design/` (spec.md, motion.md, src/req.css).
import type { StyleDesc } from '@gpuix/react'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import { Icon, ICONS } from '../icons.tsx'
import { Collapse, SCALE } from '../motion/kit.tsx'
import { pressTransform } from '../motion/press.ts'
import { EDGE_FADE } from '../native/local-build.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { Kbd } from '../kit/Kbd.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { SuccessCheck } from '../motion/SuccessCheck.tsx'
import { RG } from './glyphs.ts'
import { CodeText } from './summoned.tsx'
import { TextField } from '../kit/Field.tsx'
import { useControls } from '../kit/controls.ts'
import { useGlass } from '../platform/glass.ts'
import { T } from '../transcript/glyphs.ts'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { basename } from '../../../desktop/src/lib/format.ts'
import { splitChecklistPreview } from '../../../../packages/kybern-client/src/agentItemTools.ts'
import { clampRows, commandRows, shellTokens, type CodeRow, type TokenKind } from './shell.ts'
import type { CardModel, DiffLine, DiffSpec, GrantLine, Part, WellSpec } from './model.ts'
import { registerCardFocus, someoneIsTyping } from './ui.ts'

/** The colours of the card's parts: Direction C's ink and accent alphas, with the glass and light variants of the well. */
export function useCardTokens() {
  const t = useTheme()
  const c = useControls()
  const g = useGlass()
  return useMemo(() => {
    const light = t.variant === 'light'
    return {
      t, c,
      wellFill: g.on ? 'rgba(0, 0, 0, 0.26)' : light ? c.ink(0.04) : 'rgba(0, 0, 0, 0.24)',
      wellRim: g.on ? 'rgba(255, 255, 255, 0.06)' : light ? c.ink(0.06) : c.ink(0.05),
      op: light ? '#0160bd' : '#8cc1f4',
      arg: c.ink(0.8),
      flag: c.ink(light ? 0.52 : 0.56),
      str: light ? '#1a7f37' : '#9fd3a6',
      add: light ? '#1a7f37' : '#7ad48a',
      del: light ? '#c42520' : '#ff8a83',
      addBg: light ? 'rgba(26, 138, 62, 0.09)' : 'rgba(63, 185, 80, 0.13)',
      delBg: light ? 'rgba(224, 46, 42, 0.08)' : 'rgba(255, 92, 84, 0.12)',
      hover: c.ink(light ? 0.045 : 0.05),
      highlight: c.acc(light ? 0.09 : 0.17),
      /** The free answer's row while it is the field: the selection tint at 60 %. */
      editFill: c.acc((light ? 0.09 : 0.17) * 0.6),
      highlightFg: c.accentFg,
      chipBg: c.ink(0.06),
      successBg: light ? 'rgba(26, 138, 62, 0.10)' : 'rgba(63, 185, 80, 0.16)',
      doneBg: light ? 'rgba(26, 138, 62, 0.07)' : 'rgba(63, 185, 80, 0.10)',
    }
  }, [t, c, g.on])
}
type Tokens = ReturnType<typeof useCardTokens>

const rimShadow = (color: string, spread = 1) => [{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: spread, color, inset: true }]

export const GLYPHS: Record<CardModel['glyph'], string> = {
  terminal: T.terminal, file: T.file, pencil: T.pencil, plan: T.file, plug: T.mcp, laptop: T.laptop, task: T.listChecks, note: T.note, shield: ICONS.shield,
}

// ---- keyboard focus ----

/** The card's root: one focusable element that answers the card's keys while it has focus itself. A card that arrives while nothing
 *  has focus and nobody is typing takes focus; one that arrives while the composer has focus never steals it (the composer routes
 *  the same keys). */
export function CardShell({ testId, onKey, children, stealFocus = true, cmdKeys, onPointerEnter, onPointerLeave, onFocusIn, onPointerDown, onFocusChange, onWidth }: { testId: string; onKey?: (event: { key?: string; modifiers?: { cmd?: boolean; alt?: boolean; ctrl?: boolean; shift?: boolean } }) => boolean | void; children: ReactNode; stealFocus?: boolean; /** ⌘ keys besides ⌘E that reach `onKey` (⌘C copies a sign-in code). */ cmdKeys?: string[]; onPointerEnter?: () => void; onPointerLeave?: () => void; /** A key or click landed in the card (pauses a countdown). */ onFocusIn?: () => void; /** A click landed in or outside the card: a row's focus ring hides until the next key, as `:focus-visible` would. */ onPointerDown?: () => void; /** The root itself gained or lost keyboard focus. */ onFocusChange?: (focused: boolean) => void; /** The card's own width, after the first paint and on every resize. */ onWidth?: (width: number) => void }) {
  const renderer = useGpuixRequired()
  const root = useRef<import('@gpuix/react').PublicInstance | null>(null)
  // GPUIX reports no focus event for a programmatic focus: the card says so itself when it takes focus, answers a key, or loses a click.
  const focusChange = useRef(onFocusChange)
  focusChange.current = onFocusChange
  useEffect(() => {
    return registerCardFocus(() => { if (root.current) { renderer.focusElement?.(root.current.id); focusChange.current?.(true) } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!stealFocus || someoneIsTyping() || !root.current) return
    if (renderer.getFocusedElementId?.() == null) { renderer.focusElement?.(root.current.id); onFocusChange?.(true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      ref={root} testId={testId} tabIndex={0}
      {...(onPointerEnter ? { onMouseEnter: onPointerEnter } : {})}
      {...(onPointerLeave ? { onMouseLeave: onPointerLeave } : {})}
      {...(onFocusIn || onPointerDown ? { onMouseDown: () => { onPointerDown?.(); onFocusIn?.() } } : {})}
      {...(onFocusChange ? { onFocus: () => onFocusChange(true), onBlur: () => onFocusChange(false) } : {})}
      {...(onPointerDown ? { onMouseDownOutside: onPointerDown } : {})}
      {...(onWidth ? { onLayout: (e: { width?: number }) => { if (e.width !== undefined) onWidth(e.width) } } : {})}
      onKeyDown={(e) => {
        // Keys bubble here from the card's own fields, links and buttons: a digit typed into an answer, or Return on "Cancel turn",
        // belongs to them. The card answers only while its root itself has focus (rows are not focusable).
        onFocusIn?.()
        const focused = renderer.getFocusedElementId?.()
        if (focused != null && root.current && focused !== root.current.id) return
        onFocusChange?.(true)
        const m = e.modifiers
        if (m?.alt || m?.ctrl || m?.shift) return
        if (m?.cmd && e.key !== 'e' && !cmdKeys?.includes(e.key ?? '')) return
        if (onKey?.(e)) e.preventDefault()
      }}
      style={{ display: 'flex', flexDirection: 'column', minWidth: 0, paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 12 }}
    >
      {children}
    </div>
  )
}

/** ⌘E toggles a clamped well from anywhere in the window while it is on screen. */
export function useExpandShortcut(active: boolean, toggle: () => void) {
  const latest = useRef(toggle)
  latest.current = toggle
  useEffect(() => active ? addWindowKeyHandler((e) => {
    if (e.key !== 'e' || !e.modifiers?.cmd || e.modifiers.alt || e.modifiers.ctrl || e.modifiers.shift) return false
    latest.current()
    return true
  }) : undefined, [active])
}

// ---- header ----

/** Tile, verb-first title, queue badge and context chip; the meta line sits under the title text. `tileMark` replaces the glyph
 *  (a service mark, a pane glyph); `tone="success"` turns the tile green and draws the check in; `error` sits under the title in red. */
export function RequestHeader({ glyph, title, chip, chipGlyph, chipMark, badge, aside, meta, tileMark, tone, error, wrap = false }: { glyph: string; title: string; chip?: { label: string; mono?: boolean }; chipGlyph?: string; /** A provider mark before the chip label. */ chipMark?: ReactNode; badge?: string; /** At the right: plain text ("2 answered") or a node ("Density · 2 of 3"). */ aside?: ReactNode; meta?: string; tileMark?: ReactNode; tone?: 'success'; error?: string; /** The title may wrap: the tile and the aside align to its first line. */ wrap?: boolean }) {
  const k = useCardTokens()
  const success = tone === 'success'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: wrap ? 'flex-start' : 'center', gap: 10, minHeight: 24, minWidth: 0 }}>
        <div testId={success ? 'request-success' : undefined} style={{ display: 'flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 7, flexShrink: 0, marginTop: wrap ? -2 : 0, backgroundColor: success ? k.successBg : k.chipBg }}>
          {success ? <SuccessCheck size={14} color={k.add} /> : tileMark ?? <Icon source={glyph} size={14} color={k.c.kbd.fg} />}
        </div>
        <div style={{ display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          <text style={{ color: k.t.text, fontSize: 14, lineHeight: 20, fontWeight: 600, fontFamily: '.SystemUIFont', minWidth: 0 }}>{title}</text>
        </div>
        {badge && (
          <div style={{ display: 'flex', alignItems: 'center', height: 20, paddingLeft: 7, paddingRight: 7, borderRadius: 999, flexShrink: 0, backgroundColor: k.c.acc(k.t.variant === 'light' ? 0.1 : 0.2) }}>
            <Label color={k.highlightFg} size={11.5} lineHeight={14} weight={600} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{badge}</Label>
          </div>
        )}
        {aside != null && aside !== false && (typeof aside === 'string'
          ? <Label color={k.t.textTertiary} size={12} lineHeight={wrap ? 20 : 16} style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' } as never}>{aside}</Label>
          : aside)}
        {chip && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, height: 22, paddingLeft: chipGlyph || chipMark ? 7 : 9, paddingRight: 9, borderRadius: 999, flexShrink: 1, minWidth: 0, backgroundColor: k.chipBg }}>
            {chipMark ?? (chipGlyph && <Icon source={chipGlyph} size={12} color={k.t.textTertiary} />)}
            <Label color={k.t.textSecondary} size={chip.mono ? 11 : 12} lineHeight={14} weight={500} font={chip.mono ? FONT_MONO : undefined} truncate>{chip.label}</Label>
          </div>
        )}
      </div>
      {meta && (
        <text style={{ color: k.t.textSecondary, fontSize: 12, lineHeight: 17, fontFamily: '.SystemUIFont', marginLeft: 34, marginTop: 4, minWidth: 0 }}>{meta}</text>
      )}
      {error && (
        <text testId="request-error" style={{ color: k.del, fontSize: 12, lineHeight: 17, fontFamily: '.SystemUIFont', marginLeft: 34, marginTop: 4, minWidth: 0 }}>{error.replace(/`/g, '')}</text>
      )}
    </div>
  )
}

/** The line that replaces the rows while Kybern waits (spinner, what it waits for, the time left), or the green "continuing" line. */
export function StatusRow({ tone = 'wait', label, trailing, testId }: { tone?: 'wait' | 'done'; label: string; trailing?: ReactNode; testId?: string }) {
  const k = useCardTokens()
  const done = tone === 'done'
  return (
    <div testId={testId} role="status" aria-label={label} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32, marginTop: 10, paddingLeft: 8, paddingRight: 10, borderRadius: 9, minWidth: 0, backgroundColor: done ? k.doneBg : k.c.ink(k.t.variant === 'light' ? 0.035 : 0.04) }}>
      <div style={{ display: 'flex', width: 18, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {done ? <Icon source={RG.checkCircle} size={16} color={k.add} /> : <Spinner size={14} color={k.t.textSecondary} />}
      </div>
      <Label color={k.t.text} size={13} lineHeight={18} weight={500} truncate style={{ flexGrow: 1, flexShrink: 1 }}>{label}</Label>
      {trailing}
    </div>
  )
}

/** A key–value grid in a well: keys 92 wide in `text3`, values in `text` (mono where asked). */
export function KeyValueWell({ rows, keyWidth = 92, testId }: { rows: { key: string; value: string; mono?: boolean }[]; keyWidth?: number; testId?: string }) {
  const k = useCardTokens()
  return (
    <Well>
      <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {rows.map((row) => (
          <div key={row.key} style={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }}>
            <div style={{ display: 'flex', width: keyWidth, flexShrink: 0 }}><Label color={k.t.textTertiary} size={12.5} lineHeight={18}>{row.key}</Label></div>
            {!row.mono && row.value.includes('`')
              ? <div style={{ display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0 }}><CodeText text={row.value} size={12.5} lineHeight={18} color={k.t.text} /></div>
              : <text style={{ color: k.t.text, fontSize: row.mono ? 11.5 : 12.5, lineHeight: 18, fontFamily: row.mono ? FONT_MONO : '.SystemUIFont', minWidth: 0, flexGrow: 1, flexShrink: 1, userSelect: 'text' }}>{row.value}</text>}
          </div>
        ))}
      </div>
    </Well>
  )
}

// ---- wells ----

export function Well({ children, indent = 0, style }: { children: ReactNode; indent?: number; style?: StyleDesc }) {
  const k = useCardTokens()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, marginTop: 10, marginLeft: indent, paddingLeft: 10, paddingRight: 12, paddingTop: 9, paddingBottom: 9, borderRadius: 9, overflow: 'hidden', backgroundColor: k.wellFill, boxShadow: rimShadow(k.wellRim), ...style }}>
      {children}
    </div>
  )
}

/** "Show all 8 lines or press ⌘E" / "Show less": under a clamped well. */
export function ExpandLink({ expanded, label, onClick, testId }: { expanded: boolean; label: string; onClick: () => void; testId?: string }) {
  const k = useCardTokens()
  return (
    <div testId={testId} role="button" aria-label={expanded ? 'Show less' : label} tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') onClick() }}
      style={{ display: 'flex', alignItems: 'center', gap: 4, height: 22, marginTop: 4, alignSelf: 'flex-start', borderRadius: 6, cursor: 'pointer' }}>
      <Icon source={expanded ? T.chevronDown : T.chevronRight} size={12} color={k.t.textTertiary} />
      <Label color={k.t.textSecondary} size={12} lineHeight={16} weight={500}>{expanded ? 'Show less' : label}</Label>
      <Label color={k.t.textTertiary} size={12} lineHeight={16} style={{ marginLeft: 4 }}>or press</Label>
      <Kbd keys={['⌘', 'E']} />
    </div>
  )
}

const KIND_COLOR = (k: Tokens, kind: TokenKind): string => kind === 'cmd' ? k.t.text : kind === 'flag' || kind === 'comment' ? k.flag : kind === 'str' ? k.str : kind === 'op' ? k.op : kind === 'var' ? k.flag : k.arg

const MONO = { fontFamily: FONT_MONO, fontSize: 12, lineHeight: 18 } as const

function CodeLine({ row, k }: { row: CodeRow; k: Tokens }) {
  const isOp = row.gutter !== '' && row.gutter !== '$'
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }}>
      <div style={{ display: 'flex', width: 22, flexShrink: 0 }}>
        <text style={{ ...MONO, color: isOp ? k.op : k.t.textTertiary, fontWeight: isOp ? 600 : 400, userSelect: 'none' }}>{row.gutter}</text>
      </div>
      {row.body
        ? <text style={{ ...MONO, color: k.flag, minWidth: 0, flexGrow: 1, flexShrink: 1, userSelect: 'text' }}>{row.text || ' '}</text>
        : (
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', minWidth: 0, flexGrow: 1, flexShrink: 1 }}>
            {shellTokens(row.text).map((token, i) => (
              <text key={i} style={{ ...MONO, color: KIND_COLOR(k, token.kind), fontWeight: token.kind === 'op' ? 600 : 400, whiteSpace: 'nowrap', userSelect: 'text' }}>{`${token.text} `}</text>
            ))}
          </div>
        )}
    </div>
  )
}

/** The command the shell will run, one command per line with its operator in the gutter, at most 6 lines until expanded. */
export function CodeWell({ command, expanded, onToggle }: { command: string; expanded: boolean; onToggle: () => void }) {
  const k = useCardTokens()
  const all = useMemo(() => commandRows(command), [command])
  const { rows, total, clamped } = useMemo(() => clampRows(all, expanded ? Infinity : 6), [all, expanded])
  const canExpand = expanded || clamped
  useExpandShortcut(canExpand, onToggle)
  return (
    <Well>
      <div testId="approval-command" edgeFade={clamped && EDGE_FADE ? { bottom: 30 } : undefined} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {rows.map((row, i) => <CodeLine key={i} row={row} k={k} />)}
      </div>
      {canExpand && <ExpandLink testId="approval-expand" expanded={expanded} label={`Show all ${total} lines`} onClick={onToggle} />}
    </Well>
  )
}

const DIFF_LINES = 8
const splitPath = (path: string): { name: string; dir: string } => {
  const name = basename(path)
  const dir = path.slice(0, Math.max(0, path.length - name.length))
  return { name, dir: dir.length > 28 ? `…${dir.slice(-27)}` : dir }
}

function FileRow({ path, stats }: { path: string; stats?: { added: number; removed: number } }) {
  const k = useCardTokens()
  const { name, dir } = splitPath(path)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <Icon source={T.file} size={14} color={k.t.textSecondary} />
      <Label color={k.t.text} size={13} lineHeight={18} weight={500}>{name}</Label>
      {dir && <Label color={k.t.textTertiary} size={11} lineHeight={16} font={FONT_MONO} truncate>{dir}</Label>}
      <div style={{ flexGrow: 1 }} />
      {stats && (
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <Label color={k.add} size={12} lineHeight={16} weight={500} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{`+${stats.added}`}</Label>
          <Label color={k.del} size={12} lineHeight={16} weight={500} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{`−${stats.removed}`}</Label>
        </div>
      )}
    </div>
  )
}

function DiffRow({ line, k }: { line: DiffLine; k: Tokens }) {
  const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', paddingLeft: 10, paddingRight: 12, backgroundColor: line.kind === 'add' ? k.addBg : line.kind === 'del' ? k.delBg : 'rgba(0, 0, 0, 0)' }}>
      <div style={{ display: 'flex', width: 14, flexShrink: 0 }}>
        <text style={{ fontFamily: FONT_MONO, fontSize: 11.5, lineHeight: 17, color: line.kind === 'add' ? k.add : line.kind === 'del' ? k.del : k.t.textTertiary, userSelect: 'none' }}>{mark}</text>
      </div>
      <text style={{ fontFamily: FONT_MONO, fontSize: 11.5, lineHeight: 17, color: line.kind === 'ctx' ? k.arg : k.t.text, minWidth: 0, flexGrow: 1, flexShrink: 1, userSelect: 'text' }}>{line.text || ' '}</text>
    </div>
  )
}

/** The file and the change: its name, `+n −n` and up to 8 diff lines until expanded. */
export function DiffWell({ diff, expanded, onToggle }: { diff: DiffSpec; expanded: boolean; onToggle: () => void }) {
  const k = useCardTokens()
  const clamped = !expanded && diff.lines.length > DIFF_LINES
  const lines = clamped ? diff.lines.slice(0, DIFF_LINES) : diff.lines
  useExpandShortcut(expanded || clamped, onToggle)
  return (
    <Well>
      <FileRow path={diff.path} stats={{ added: diff.added, removed: diff.removed }} />
      {lines.length > 0 && (
        <div testId="approval-diff" edgeFade={clamped && EDGE_FADE ? { bottom: 28 } : undefined} style={{ display: 'flex', flexDirection: 'column', marginTop: 7, marginLeft: -10, marginRight: -12 }}>
          {lines.map((line, i) => <DiffRow key={i} line={line} k={k} />)}
        </div>
      )}
      {(expanded || clamped) && <ExpandLink testId="approval-expand" expanded={expanded} label={`Show all ${diff.lines.length} lines`} onClick={onToggle} />}
    </Well>
  )
}

const PLAN_LINES = 6

/** The head of the plan as Markdown; the rest opens with ⌘E. */
export function PlanWell({ plan, expanded, onToggle }: { plan: string; expanded: boolean; onToggle: () => void }) {
  const k = useCardTokens()
  const lines = plan.split('\n')
  const clamped = !expanded && lines.length > PLAN_LINES
  useExpandShortcut(expanded || clamped, onToggle)
  return (
    <Well>
      <div testId="approval-plan" edgeFade={clamped && EDGE_FADE ? { bottom: 30 } : undefined} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <markdown source={clamped ? lines.slice(0, PLAN_LINES).join('\n') : lines.slice(0, 60).join('\n')} theme={cachedMarkdownTheme(k.t)} style={{ color: k.t.text, userSelect: 'text' }} />
      </div>
      {(expanded || clamped) && <ExpandLink testId="approval-expand" expanded={expanded} label="Show full plan" onClick={onToggle} />}
    </Well>
  )
}

export function FileWell({ path }: { path: string }) {
  return <Well><FileRow path={path} /></Well>
}

/** One line per permission: its glyph, name and what it covers. */
export function GrantWell({ lines }: { lines: GrantLine[] }) {
  const k = useCardTokens()
  return (
    <Well>
      {lines.map((line, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 24, minWidth: 0 }}>
          <Icon source={line.glyph === 'folder' ? ICONS.folder : line.glyph === 'network' ? T.globe : T.hammer} size={14} color={k.t.textSecondary} />
          <Label color={k.t.text} size={13} lineHeight={18} weight={500}>{line.name}</Label>
          <div style={{ flexGrow: 1 }} />
          {line.target && <Label color={k.t.textSecondary} size={11.5} lineHeight={16} font={FONT_MONO} truncate>{line.target}</Label>}
        </div>
      ))}
    </Well>
  )
}

/** Raw request text, for a request with no layout of its own (at most 8 lines). */
export function TextWell({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  const k = useCardTokens()
  const lines = text.split('\n')
  const clamped = !expanded && lines.length > DIFF_LINES
  useExpandShortcut(expanded || clamped, onToggle)
  return (
    <Well>
      <text style={{ ...MONO, color: k.arg, userSelect: 'text', minWidth: 0 }}>{clamped ? lines.slice(0, DIFF_LINES).join('\n') : text}</text>
      {(expanded || clamped) && <ExpandLink expanded={expanded} label={`Show all ${lines.length} lines`} onClick={onToggle} />}
    </Well>
  )
}

/** A note or task change: its text and up to 5 checklist items, indented under the title. */
export function NotesWell({ preview }: { preview: string }) {
  const k = useCardTokens()
  const split = splitChecklistPreview(preview)
  const shown = split.items.slice(0, 5)
  return (
    <Well indent={34} style={{ gap: 2 }}>
      {split.text && <text style={{ color: k.arg, fontSize: 12, lineHeight: 17.4, fontFamily: '.SystemUIFont', lineClamp: 3, minWidth: 0 }}>{split.text}</text>}
      {shown.map((item, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: i === 0 && split.text ? 4 : 0 }}>
          <div style={{ width: 12, height: 12, borderRadius: 3.5, flexShrink: 0, boxShadow: rimShadow(k.c.ink(0.3), 1.25), backgroundColor: item.checked ? k.c.ink(0.3) : 'rgba(0, 0, 0, 0)' }} />
          <Label color={k.arg} size={12.5} lineHeight={19} truncate>{item.text}</Label>
        </div>
      ))}
      {split.items.length > shown.length && <Label color={k.t.textSecondary} size={12} lineHeight={17} style={{ paddingLeft: 21 }}>{`${split.items.length - shown.length} more ${split.items.length - shown.length === 1 ? 'criterion' : 'criteria'}`}</Label>}
    </Well>
  )
}

export function WellFor({ well, expanded, onToggle }: { well: WellSpec | null; expanded: boolean; onToggle: () => void }) {
  if (!well) return null
  switch (well.kind) {
    case 'command': return <CodeWell command={well.command} expanded={expanded} onToggle={onToggle} />
    case 'diff': return <DiffWell diff={well.diff} expanded={expanded} onToggle={onToggle} />
    case 'file': return <FileWell path={well.path} />
    case 'plan': return <PlanWell plan={well.plan} expanded={expanded} onToggle={onToggle} />
    case 'notes': return <NotesWell preview={well.consent.preview} />
    case 'grants': return <GrantWell lines={well.lines} />
    case 'text': return <TextWell text={well.text} expanded={expanded} onToggle={onToggle} />
  }
}

// ---- rows ----

/** A row's label: words, with commands in the inline code chip. Pieces wrap like running text. */
export function RowLabel({ parts, color, weight, code }: { parts: Part[]; color: string; weight: number; code: string }) {
  if (parts.length === 1 && !parts[0]!.code) return <text style={{ color, fontSize: 13, lineHeight: 18, fontWeight: weight, fontFamily: '.SystemUIFont', minWidth: 0, userSelect: 'none', pointerEvents: 'none' }}>{parts[0]!.text}</text>
  return (
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', minWidth: 0, pointerEvents: 'none' }}>
      {parts.flatMap((part, i) => part.code
        ? [<div key={i} style={{ display: 'flex', alignItems: 'center', height: 20, paddingLeft: 5, paddingRight: 5, borderRadius: 5, marginLeft: 1, marginRight: 1, backgroundColor: code }}>
            <text style={{ color, fontFamily: FONT_MONO, fontSize: 11.5, lineHeight: 16, fontWeight: 400, whiteSpace: 'nowrap', userSelect: 'none' }}>{part.text}</text>
          </div>]
        : part.text.split(/(\s+)/).filter(Boolean).map((piece, j) => <text key={`${i}-${j}`} style={{ color, fontSize: 13, lineHeight: 18, fontWeight: weight, fontFamily: '.SystemUIFont', whiteSpace: 'nowrap', userSelect: 'none' }}>{piece}</text>))}
    </div>
  )
}

/** The digit chip: 18 square, a 1 px ink edge; the highlighted row's edge is the accent. */
export function DigitKey({ n, highlighted }: { n: number | string; highlighted: boolean }) {
  const k = useCardTokens()
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: 5, flexShrink: 0, boxShadow: rimShadow(highlighted ? k.c.acc(0.6) : k.c.ink(0.12)) }}>
      <Label color={highlighted ? k.highlightFg : k.t.textSecondary} size={11} lineHeight={14} weight={600} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{String(n)}</Label>
    </div>
  )
}

/**
 * One numbered row. Every request card shares its geometry (ADE-69..71 question card spec): the list bleeds 8 into the card's 16
 * gutter, so the tint runs from x 8 with radius 10 (18 − 8); the lead (digit, checkbox) is centred in a 24 column at x 16, and the
 * label starts at x 50, the header title's edge; trailing glyphs end at W − 16.
 */
export function OptionRow({ n, label, description, highlighted, dim, sending, onClick, testId, children, lead, disabled, enterHint = true, cursor = false, focused = false, field, muted = false, checked = false, role = 'radio', tag }: {
  n?: number
  label: Part[]
  /** A small capsule after the label ("Default"). */
  tag?: string
  description?: string
  highlighted: boolean
  dim?: boolean
  sending?: boolean
  onClick: () => void
  testId?: string
  /** Under the label, inside the row (the decline note field). */
  children?: ReactNode
  /** Replaces the digit (a checkbox for a multi-select option). */
  lead?: ReactNode
  disabled?: boolean
  /** The tinted row shows the ↵ glyph (a picked answer in a form does not). */
  enterHint?: boolean
  /** A keyboard cursor on an untinted row (multi-select). */
  cursor?: boolean
  /** The keyboard focus ring (2 px of the accent outside the tint), while the card holds keyboard focus. */
  focused?: boolean
  /** Replaces the label: the row is that field (the question's free answer), with the field's tint and the ring as its edge. */
  field?: ReactNode
  /** The label in `text2` ("Something else…"). */
  muted?: boolean
  /** A checked multi-select row: the label goes to 600 with no tint. */
  checked?: boolean
  role?: 'radio' | 'checkbox'
}) {
  const k = useCardTokens()
  const tall = !!children || !!description
  const editing = field !== undefined
  const fg = highlighted ? k.highlightFg : muted ? k.t.textSecondary : k.t.text
  const weight = highlighted || checked ? 600 : 500
  const labelNode = <RowLabel parts={label} color={fg} weight={weight} code={highlighted ? k.c.acc(0.2) : k.chipBg} />
  return (
    <div
      testId={testId} role={role} aria-checked={highlighted || checked} aria-label={label.map((p) => p.text).join('')} aria-keyshortcuts={n ? String(n) : undefined}
      onClick={disabled || editing ? undefined : onClick}
      paintTransform={pressTransform(!disabled && !children && !editing, SCALE.tiny)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, minHeight: 32, borderRadius: 10, minWidth: 0,
        paddingLeft: 8, paddingRight: 8, paddingTop: 7, paddingBottom: tall ? 8 : 7,
        opacity: dim ? 0.38 : 1, cursor: disabled ? 'default' : editing ? 'text' : 'pointer',
        backgroundColor: editing ? k.editFill : highlighted ? k.highlight : cursor ? k.hover : 'rgba(0, 0, 0, 0)',
        ...(focused || editing ? { outlineWidth: 2, outlineColor: k.c.focus, outlineOffset: 0 } : {}),
        ...(highlighted || disabled || editing ? {} : { hover: { backgroundColor: k.hover } }),
      }}
    >
      <div style={{ display: 'flex', width: 24, height: 18, alignItems: 'center', justifyContent: 'center', flexShrink: 0, pointerEvents: 'none' }}>
        {lead ?? (n !== undefined ? <DigitKey n={n} highlighted={highlighted || editing} /> : null)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 1 }}>
        {editing
          ? field
          : tag
            ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {labelNode}
                <div testId={testId ? `${testId}-tag` : undefined} style={{ display: 'flex', alignItems: 'center', height: 18, paddingLeft: 7, paddingRight: 7, borderRadius: 999, flexShrink: 0, backgroundColor: highlighted ? k.c.acc(0.2) : k.chipBg, pointerEvents: 'none' }}>
                  <Label color={highlighted ? k.highlightFg : k.t.textSecondary} size={11} lineHeight={14} weight={500}>{tag}</Label>
                </div>
              </div>
            )
            : labelNode}
        {description && !editing && <text style={{ color: k.t.textSecondary, fontSize: 12, lineHeight: 17, fontFamily: '.SystemUIFont', minWidth: 0, pointerEvents: 'none' }}>{description}</text>}
        {children}
      </div>
      {sending
        ? <Spinner size={14} color={k.highlightFg} />
        : highlighted && enterHint && !children && !editing ? <Label color={k.highlightFg} size={13} lineHeight={18}>↵</Label> : null}
    </div>
  )
}

/** The note field inside the Decline row: Return sends, Esc goes back. */
export function NoteField({ agent, value, onChange, onSend, onBack }: { agent: string; value: string; onChange: (value: string) => void; onSend: () => void; onBack: () => void }) {
  return (
    <Collapse open height={37}>
      <div style={{ display: 'flex', marginTop: 7, paddingBottom: 0 }}>
        <TextField
          label={`Tell ${agent} what to do instead`} testId="approval-note" autoFocus value={value} onChange={onChange}
          placeholder={`Tell ${agent} what to do instead`}
          interceptKeys={['enter', 'escape']}
          onKeyDown={(e) => {
            if (e.key === 'escape') { e.preventDefault(); onBack() } else if (e.key === 'enter' && !e.modifiers?.shift) { e.preventDefault(); onSend() }
          }}
          shell={{ flexGrow: 1, height: 30, borderRadius: 8 }}
        />
      </div>
    </Collapse>
  )
}

/** The rows, bled 8 into the card's gutter on both sides (`bleed="start"`: the leading side only, beside a preview pane). */
export function OptionList({ children, label, bleed = 'both', style }: { children: ReactNode; label: string; bleed?: 'both' | 'start'; style?: StyleDesc }) {
  return <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10, marginLeft: -8, marginRight: bleed === 'both' ? -8 : 0, minWidth: 0, ...style }}>{children}</div>
}

// ---- hint line ----

/** "Cancel turn esc": a quiet text action. */
export function CancelLink({ onClick }: { onClick: () => void }) {
  const k = useCardTokens()
  return (
    <div testId="approval-cancel" role="button" aria-label="Cancel turn" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') onClick() }}
      style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, paddingLeft: 8, paddingRight: 6, borderRadius: 7, cursor: 'pointer', flexShrink: 0, hover: { backgroundColor: k.chipBg } }}>
      <Label color={k.t.textSecondary} size={12} lineHeight={16} weight={500}>Cancel turn</Label>
      <Kbd keys={['esc']} />
    </div>
  )
}

/** The line under the rows: the keys on the left, the quiet action (or a form's buttons) on the right. */
/** The keys sit on the lead edge (x 16, the digit column), the actions on the trailing edge (W − 16). `actions` is a footer with
 *  28 pt buttons (a question's Attach, Decline, Send): 10 above it and 28 high. */
export function Hints({ left, right, error, actions = false }: { left: ReactNode; right?: ReactNode; error?: string; actions?: boolean }) {
  const k = useCardTokens()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {error && <text style={{ color: k.t.red, fontSize: 12, lineHeight: 17, fontFamily: '.SystemUIFont', marginTop: 6, minWidth: 0 }}>{error}</text>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: actions ? 10 : 8, minHeight: actions ? 28 : 22, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>{left}</div>
        {right}
      </div>
    </div>
  )
}

/** A line of hint text with key chips between its words. */
export function HintText({ children }: { children: string }) {
  const k = useCardTokens()
  return <Label color={k.t.textTertiary} size={12} lineHeight={16}>{children}</Label>
}
export { Kbd }
