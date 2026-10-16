import { motion, useGpuixRequired } from '@gpuix/react'
import { memo, useMemo, useRef, useState } from 'react'
import type { MotionTransition, StyleDesc } from '@gpuix/react'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { TREE_BRANCH, TREE_ENTER, TREE_ROW_HEIGHT, treeMotionCapabilities, treeSpring, type TreeMotionStyle } from './fileTreeMotion.ts'
import { getFileIconName } from '../../../desktop/src/lib/kit/fileIcons.ts'
import { diffFileIcons } from '../native/diff-file-icons.ts'
import { fileIconColors } from '../native/DiffView.tsx'
import { alpha } from '../transcript/kit.tsx'

export type TreeRow = { key: string; path: string; name: string; kind: string; depth: number; position: number; setSize: number }

export function MotionFileTreeRows({ rows, open, selected, focus, virtual, search = false, activate }: {
  rows: TreeRow[]; open: ReadonlySet<string>; selected: string | null; focus: number; virtual: boolean; search?: boolean; activate: (row: TreeRow, index: number) => void
}) {
  const reduce = REDUCED_MOTION || virtual || search
  const t = useTheme(), capability = treeMotionCapabilities(useGpuixRequired())
  const [hovered, setHovered] = useState<string | null>(null)
  const indexes = new Map(rows.map((row, index) => [row.key, index]))
  // Desktop layout="position": change scroll geometry once and project the
  // surviving rows to their new slots. No per-frame branch-height reflow.
  // Removed rows leave immediately, as in the desktop's visibleRows map.
  const children = rows.map((row, index) => <FileTreeRow key={row.key} row={row} index={index} open={open.has(row.path)} selected={selected === row.path} focused={focus === index} reduce={reduce} search={search} hover={reduce ? undefined : () => setHovered(row.key)} activate={() => activate(row, index)} />)
  if (reduce) return children
  const hoverIndex = hovered ? indexes.get(hovered) : undefined
  return <div onMouseLeave={() => setHovered(null)} style={{ display: 'flex', position: 'relative', width: '100%', height: rows.length * TREE_ROW_HEIGHT, flexShrink: 0 }}>
    {hoverIndex !== undefined && <motion.div initial={false} animate={{ translateY: hoverIndex * TREE_ROW_HEIGHT, opacity: 1 }} transition={reduce ? { duration: 0 } : treeSpring('layout', capability.physical)} style={{ position: 'absolute', top: 0, left: 6, right: 6, height: 28, borderRadius: 6, backgroundColor: t.v('--color-background-elevated-secondary'), pointerEvents: 'none' }} />}
    {children}
  </div>
}

const FileTreeRow = memo(function FileTreeRow({ row, index, open, selected, focused, reduce, search, hover, activate }: {
  row: TreeRow; index: number; open: boolean; selected: boolean; focused: boolean; reduce: boolean; search: boolean; hover?: () => void; activate: () => void
}) {
  const t = useTheme(), renderer = useGpuixRequired()
  const capability = treeMotionCapabilities(renderer)
  const folder = row.kind === 'directory', disabled = row.kind === 'loading' || row.kind === 'empty'
  const testId = `dock-file-${row.path || 'root'}${['loading', 'error', 'empty'].includes(row.kind) ? `-${row.kind}` : ''}`
  const rotation: TreeMotionStyle = { rotate: open ? 90 : 0, opacity: folder ? 0.75 : 0 }
  const delay = Math.min(row.position * 0.025, 0.1)
  const content = <div role="treeitem" aria-level={row.depth + 1} aria-posinset={row.position} aria-setsize={row.setSize} aria-expanded={folder ? open : undefined} aria-selected={selected} aria-disabled={disabled || undefined} testId={testId} onMouseEnter={hover} onClick={!disabled ? activate : undefined} style={{ display: 'flex', position: 'relative', alignItems: 'center', gap: 6, width: '100%', height: 28, flexShrink: 0, paddingLeft: 6 + row.depth * 14, paddingRight: 8, borderRadius: 6, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.42 : 1, backgroundColor: selected ? t.buttonSecondary : focused ? t.selected : 'transparent', hover: hover ? undefined : { backgroundColor: selected ? t.buttonSecondary : t.buttonSecondaryHover } }}>
    {row.depth > 0 && <motion.div initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: 28, opacity: 1 }} transition={reduce ? { duration: 0 } : TREE_BRANCH} style={{ position: 'absolute', top: 0, left: 13 + (row.depth - 1) * 14, width: 1, backgroundColor: alpha(t.border, 0.7), pointerEvents: 'none' }} />}
    {!search && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, flexShrink: 0, pointerEvents: 'none' }}>
      <TreeSvg testId={`dock-chevron-${row.path}`} source={open && !capability.rotate ? N.chevronDown : N.chevronRight} initial={false} animate={capability.rotate ? rotation : { opacity: folder ? 0.75 : 0 }} transition={reduce ? { duration: 0 } : treeSpring('swap', capability.physical)} style={{ width: 14, height: 14, color: alpha(t.text, 0.85), pointerEvents: 'none' }} />
    </div>}
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, flexShrink: 0, pointerEvents: 'none' }}>
      <FolderIcon folder={folder} open={open} reduce={reduce} path={row.path} />
    </div>
    <Label color={selected ? t.text : alpha(t.text, 0.85)} size={12} truncate style={{ flexGrow: 1, minWidth: 0, pointerEvents: 'none' }}>{row.name}</Label>
  </div>
  if (reduce) return <div style={{ height: TREE_ROW_HEIGHT, flexShrink: 0, paddingLeft: 6, paddingRight: 6 }}>{content}</div>
  return <motion.div initial={{ translateY: index * TREE_ROW_HEIGHT }} animate={{ translateY: index * TREE_ROW_HEIGHT }} transition={treeSpring('layout', capability.physical)} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: TREE_ROW_HEIGHT, paddingLeft: 6, paddingRight: 6 }}>
    <motion.div initial={{ opacity: 0, translateY: -6 }} animate={{ opacity: 1, translateY: 0 }} transition={{ ...TREE_ENTER, delay }} style={{ height: 28, width: '100%' }}>{content}</motion.div>
  </motion.div>
})

function FolderIcon({ folder, open, reduce, path }: { folder: boolean; open: boolean; reduce: boolean; path: string }) {
  const t = useTheme(), capability = treeMotionCapabilities(useGpuixRequired())
  const source = folder ? open ? N.folderOpen : N.folder : N.note
  const [swap, setSwap] = useState<{ open: boolean; previous: boolean | null }>({ open, previous: null })
  if (swap.open !== open) setSwap({ open, previous: reduce ? null : swap.open })
  if (!folder) { const kind = getFileIconName(path); return <Icon source={diffFileIcons[kind] ?? diffFileIcons['code-brackets']} size={14} color={fileIconColors[kind] ?? (kind === 'vercel' ? t.text : '#9ca3af')} /> }
  if (reduce || !capability.rotate) return <Icon source={source} size={14} color={open ? t.text : t.textSecondary} />
  // A single SVG is the entire scaled object. Interpolate its centred bounds
  // inside a fixed slot: exact 0.75↔1 glyph scale without a subtree-scale API.
  return <div style={{ position: 'relative', width: 16, height: 16, pointerEvents: 'none' }}>
    {[...(swap.previous === null ? [] : [swap.previous]), swap.open].map(state => {
      const leaving = state !== swap.open
      const small = { width: 10.5, height: 10.5, left: 2.75, top: 2.75 }
      const full = { width: 14, height: 14, left: 1, top: 1 }
      return <TreeSvg testId={`dock-folder-${path}-${state ? 'open' : 'closed'}`} key={state ? 'open' : 'closed'} source={state ? N.folderOpen : N.folder}
        initial={swap.previous === null ? false : { ...small, opacity: 0, rotate: state ? -8 : 8 }}
        animate={leaving ? { ...small, opacity: 0, rotate: state ? 8 : -8 } : { ...full, opacity: 1, rotate: 0 }}
        transition={treeSpring('swap', capability.physical)}
        onComplete={leaving ? () => setSwap(previous => previous.open === swap.open ? { ...previous, previous: null } : previous) : undefined}
        style={{ position: 'absolute', width: 14, height: 14, left: 1, top: 1, color: state ? t.text : t.textSecondary, pointerEvents: 'none' }} />
    })}
  </div>
}
let svgGeneration = 7_000_000
/** Raw SVG motion is also understood before the additive motion.svg JS wrapper lands. */
function TreeSvg({ source, initial, animate, transition, style, onComplete, testId }: { source: string; initial: TreeMotionStyle | false; animate: TreeMotionStyle; transition: MotionTransition; style: StyleDesc; onComplete?: () => void; testId?: string }) {
  // Initial belongs to this keyed glyph's mount, not to later swap cleanup.
  // Keeping it stable avoids restarting the incoming spring when its peer exits.
  const mountedInitial = useRef(initial).current
  const identity = JSON.stringify([mountedInitial, animate, transition])
  const generation = useMemo(() => ++svgGeneration, [identity])
  return <svg testId={testId} source={source} {...({ motion: { generation, isExit: false, initial: mountedInitial, animate, transition } } as object)} onMotionComplete={event => { if (event.motionGeneration === generation) onComplete?.() }} style={style} />
}
