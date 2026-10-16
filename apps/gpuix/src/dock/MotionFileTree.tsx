import { motion, useGpuixRequired } from '@gpuix/react'
import { memo, useMemo, useState } from 'react'
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
type RetainedRow = { row: TreeRow; leaving: boolean }

export function MotionFileTreeRows({ rows, open, selected, focus, virtual, activate }: {
  rows: TreeRow[]; open: ReadonlySet<string>; selected: string | null; focus: number; virtual: boolean; activate: (row: TreeRow, index: number) => void
}) {
  const reduce = REDUCED_MOTION || virtual
  const t = useTheme(), capability = treeMotionCapabilities(useGpuixRequired())
  const [hovered, setHovered] = useState<string | null>(null)
  const [state, setState] = useState<{ input: TreeRow[]; rows: RetainedRow[] }>({ input: rows, rows: rows.map(row => ({ row, leaving: false })) })
  if (state.input !== rows) {
    const incoming = new Set(rows.map(row => row.key))
    if (hovered && !incoming.has(hovered)) setHovered(null)
    const next = rows.map(row => ({ row, leaving: false }))
    if (!reduce) state.rows.forEach(({ row }, index) => { if (!incoming.has(row.key)) next.splice(index, 0, { row, leaving: true }) })
    setState({ input: rows, rows: next })
  }
  const indexes = new Map(rows.map((row, index) => [row.key, index]))
  // Exactly like the desktop, large collections use fixed-height virtual rows
  // without row motion. Small branches retain exiting rows until native finish.
  const children = state.rows.map(({ row, leaving }) => <FileTreeRow key={row.key} row={row} open={open.has(row.path)} selected={selected === row.path} focused={!leaving && focus === indexes.get(row.key)} reduce={reduce} leaving={leaving} hover={virtual ? undefined : () => setHovered(row.key)} onExit={() => setState(previous => ({ ...previous, rows: previous.rows.filter(item => item.row.key !== row.key || !item.leaving) }))} activate={() => activate(row, indexes.get(row.key) ?? 0)} />)
  if (virtual) return children
  const hoverIndex = hovered ? indexes.get(hovered) : undefined
  return <div onMouseLeave={() => setHovered(null)} style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100%', flexShrink: 0 }}>
    {hoverIndex !== undefined && <motion.div initial={false} animate={{ top: hoverIndex * TREE_ROW_HEIGHT, opacity: 1 }} transition={reduce ? { duration: 0 } : treeSpring('layout', capability.physical)} style={{ position: 'absolute', left: 6, right: 6, height: 28, borderRadius: 6, backgroundColor: t.v('--color-background-elevated-secondary'), pointerEvents: 'none' }} />}
    {children}
  </div>
}

const FileTreeRow = memo(function FileTreeRow({ row, open, selected, focused, reduce, leaving, hover, onExit, activate }: {
  row: TreeRow; open: boolean; selected: boolean; focused: boolean; reduce: boolean; leaving: boolean; hover?: () => void; onExit: () => void; activate: () => void
}) {
  const t = useTheme(), renderer = useGpuixRequired()
  const present = !leaving
  const capability = treeMotionCapabilities(renderer)
  const folder = row.kind === 'directory', disabled = row.kind === 'loading' || row.kind === 'empty'
  const testId = `dock-file-${row.path || 'root'}${['loading', 'error', 'empty'].includes(row.kind) ? `-${row.kind}` : ''}`
  const rotation: TreeMotionStyle = { rotate: open ? 90 : 0, opacity: folder ? 0.75 : 0 }
  const delay = Math.min(row.position * 0.025, 0.1)
  const content = <div role="treeitem" aria-level={row.depth + 1} aria-posinset={row.position} aria-setsize={row.setSize} aria-expanded={folder ? open : undefined} aria-selected={selected} aria-disabled={disabled || undefined} testId={testId} onMouseEnter={present ? hover : undefined} onClick={present && !disabled ? activate : undefined} style={{ display: 'flex', position: 'relative', alignItems: 'center', gap: 6, width: '100%', height: 28, flexShrink: 0, paddingLeft: 6 + row.depth * 14, paddingRight: 8, borderRadius: 6, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.42 : 1, pointerEvents: present ? undefined : 'none', backgroundColor: selected ? t.buttonSecondary : focused ? t.selected : 'transparent', hover: hover ? undefined : { backgroundColor: selected ? t.buttonSecondary : t.buttonSecondaryHover } }}>
    {row.depth > 0 && <motion.div initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: 28, opacity: 1 }} transition={reduce ? { duration: 0 } : TREE_BRANCH} style={{ position: 'absolute', top: 0, left: 13 + (row.depth - 1) * 14, width: 1, backgroundColor: alpha(t.border, 0.7), pointerEvents: 'none' }} />}
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, flexShrink: 0, pointerEvents: 'none' }}>
      <TreeSvg source={open && !capability.rotate ? N.chevronDown : N.chevronRight} initial={false} animate={capability.rotate ? rotation : { opacity: folder ? 0.75 : 0 }} transition={reduce ? { duration: 0 } : treeSpring('swap', capability.physical)} style={{ width: 14, height: 14, color: alpha(t.text, 0.85), pointerEvents: 'none' }} />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, flexShrink: 0, pointerEvents: 'none' }}>
      <FolderIcon folder={folder} open={open} reduce={reduce} path={row.path} />
    </div>
    <Label color={selected ? t.text : alpha(t.text, 0.85)} size={12} truncate style={{ flexGrow: 1, minWidth: 0, pointerEvents: 'none' }}>{row.name}</Label>
  </div>
  if (reduce) return <div style={{ height: TREE_ROW_HEIGHT, flexShrink: 0, paddingLeft: 6, paddingRight: 6 }}>{content}</div>
  return <motion.div initial={{ height: 0 }} animate={{ height: leaving ? 0 : TREE_ROW_HEIGHT }} transition={treeSpring('layout', capability.physical)} onMotionComplete={leaving ? onExit : undefined} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden', paddingLeft: 6, paddingRight: 6 }}>
    <motion.div initial={{ opacity: 0, translateY: -6 }} animate={{ opacity: leaving ? 0 : 1, translateY: 0 }} transition={{ ...TREE_ENTER, delay: leaving ? 0 : delay }} style={{ height: 28, flexShrink: 0 }}>{content}</motion.div>
  </motion.div>
})

function FolderIcon({ folder, open, reduce, path }: { folder: boolean; open: boolean; reduce: boolean; path: string }) {
  const t = useTheme(), capability = treeMotionCapabilities(useGpuixRequired())
  const source = folder ? open ? N.folderOpen : N.folder : N.note
  // A single fixed slot; changing folder state never shifts its label.
  const initial = useMemo<TreeMotionStyle>(() => ({ opacity: 0, rotate: folder && capability.rotate ? (open ? -8 : 8) : 0 }), [folder, open, capability.rotate])
  if (!folder) { const kind = getFileIconName(path); return <Icon source={diffFileIcons[kind] ?? diffFileIcons['code-brackets']} size={14} color={fileIconColors[kind] ?? (kind === 'vercel' ? t.text : '#9ca3af')} /> }
  if (reduce || !capability.rotate) return <Icon source={source} size={14} color={open ? t.text : t.textSecondary} />
  return <TreeSvg key={open ? 'open' : 'closed'} source={source} initial={initial} animate={{ opacity: 1, rotate: 0 }} transition={treeSpring('swap', capability.physical)} style={{ width: 14, height: 14, color: open ? t.text : t.textSecondary, pointerEvents: 'none' }} />
}
let svgGeneration = 7_000_000
/** Raw SVG motion is also understood before the additive motion.svg JS wrapper lands. */
function TreeSvg({ source, initial, animate, transition, style }: { source: string; initial: TreeMotionStyle | false; animate: TreeMotionStyle; transition: MotionTransition; style: StyleDesc }) {
  const identity = JSON.stringify([initial, animate, transition])
  const generation = useMemo(() => ++svgGeneration, [identity])
  return <svg source={source} {...({ motion: { generation, isExit: false, initial, animate, transition } } as object)} style={style} />
}
