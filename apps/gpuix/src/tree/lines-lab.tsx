// Lab for `verify.lines.ts`: tree groups at fractional offsets drawn by `TreeLines`, the same groups drawn the old way
// (0.5 px fills, `fill`), the same groups as the sidebar draws them (`TreeLines` per row from a fixed shape, a toggle
// joint mid-group, `fixed`), a group that opens with its draw-in and a live group whose rows arrive. Harness-only.
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTheme } from '../ui.tsx'
import { markTreeOpen, treeLine, TreeGroup, TreeItem, TreeLines, useTreeSlot, type TreeShape } from './Tree.tsx'
import { treeSegments } from './geometry.ts'

export const OFFSETS = [0, 0.25, 0.5, 0.75]
export const ROW = 24
export const STEM_X = 8
export const TICK_END = 20
const CHILDREN = 6
const PARENT: TreeShape = { anchor: ROW / 2, below: { x: STEM_X, from: ROW / 2 + 9 } }

/** The connectors as they were painted before: `HAIRLINE`-thick fills. */
function FillLines({ shape }: { shape: TreeShape }) {
  const color = treeLine(useTheme())
  return <>{treeSegments(shape).map(s => (
    <div key={s.key} style={{ position: 'absolute', left: s.left, top: s.top, width: s.width, ...(s.height !== undefined ? { height: s.height } : { bottom: s.bottom ?? 0 }),
      ...(s.corner ? { borderLeftWidth: 0.5, borderBottomWidth: 0.5, borderColor: color, borderBottomLeftRadius: s.corner } : { backgroundColor: color }), pointerEvents: 'none' }} />
  ))}</>
}

function Child({ label }: { label: string }) {
  const t = useTheme()
  const tree = useTreeSlot()
  return (
    <div paintTransform={tree.rise} style={{ position: 'relative', height: ROW, display: 'flex', alignItems: 'center', paddingLeft: TICK_END + 4 }}>
      <text style={{ color: t.textSecondary, fontSize: 12 }}>{label}</text>
      {tree.lines}
    </div>
  )
}

/** A parent row and its children; `fill` paints the old way and `fixed` the sidebar's way (the children's shapes by hand, no motion). */
function Group({ id, count, fill = false, fixed = false, arrive = false, open = true, left, top }: { id: string; count: number; fill?: boolean; fixed?: boolean; arrive?: boolean; open?: boolean; left: number; top: number }) {
  const t = useTheme()
  const rows = Array.from({ length: count }, (_, i) => i)
  return (
    <div testId={id} style={{ position: 'absolute', left, top, width: 130, display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative', height: ROW, display: 'flex', alignItems: 'center', paddingLeft: 2 }}>
        <text style={{ color: t.text, fontSize: 12 }}>{id}</text>
        {open && (fill ? <FillLines shape={PARENT} /> : <TreeLines shape={PARENT} />)}
      </div>
      {open && (fill || fixed
        ? rows.map(i => {
          const shape: TreeShape = { branch: { x: STEM_X, joint: fixed && i === 2 ? 'toggle' : 'node', last: i === count - 1, tickEnd: TICK_END }, anchor: ROW / 2 }
          return (
            <div key={i} style={{ position: 'relative', height: ROW, display: 'flex', alignItems: 'center', paddingLeft: TICK_END + 4 }}>
              <text style={{ color: t.textSecondary, fontSize: 12 }}>{`step ${i + 1}`}</text>
              {fill ? <FillLines shape={shape} /> : <TreeLines shape={shape} />}
            </div>
          )
        })
        : <TreeGroup x={STEM_X} tickEnd={TICK_END} arrive={arrive}>
          {rows.map(i => <TreeItem key={i} joint="node" last={i === count - 1} index={i} count={count} anchor={ROW / 2}><Child label={`step ${i + 1}`} /></TreeItem>)}
        </TreeGroup>)}
    </div>
  )
}

function Lab(): ReactNode {
  const t = useTheme()
  const [opened, setOpened] = useState(false)
  const [arrived, setArrived] = useState(1)
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!live || arrived >= CHILDREN) return
    const timer = setTimeout(() => setArrived(n => n + 1), 120)
    return () => clearTimeout(timer)
  }, [live, arrived])
  return (
    <div testId="ready" style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.surface }}>
      {OFFSETS.map((o, i) => <Group key={`tree-${i}`} id={`tree-${i}`} count={CHILDREN} left={16 + i * 150 + o} top={16 + o} />)}
      {OFFSETS.map((o, i) => <Group key={`fill-${i}`} id={`fill-${i}`} count={CHILDREN} fill left={16 + i * 150 + o} top={216 + o} />)}
      {OFFSETS.map((o, i) => <Group key={`fixed-${i}`} id={`fixed-${i}`} count={CHILDREN} fixed left={16 + i * 150 + o} top={616 + o} />)}
      <Group id="opening" count={CHILDREN} open={opened} left={16.5} top={416.25} />
      <Group id="arriving" count={arrived} arrive left={166.25} top={416.5} />
      <div testId="open" onClick={() => { markTreeOpen(); setOpened(true) }} style={{ position: 'absolute', left: 340, top: 420, width: 100, height: 24, backgroundColor: t.hover }}><text style={{ color: t.text }}>Open</text></div>
      <div testId="go" onClick={() => setLive(true)} style={{ position: 'absolute', left: 460, top: 420, width: 100, height: 24, backgroundColor: t.hover }}><text style={{ color: t.text }}>Arrive</text></div>
    </div>
  )
}

render(<Lab />, { title: 'Tree lines', width: 640, height: 800, focus: false })
