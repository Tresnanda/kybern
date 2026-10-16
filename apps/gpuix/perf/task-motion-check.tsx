import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { createTestRoot } from '@gpuix/react/testing'
import { ShiftRow, createShiftStore } from '../src/drag/shift.tsx'
import { TASK_SORT_MOTION } from '../src/tasks/motion.ts'
// Exercise the actual task ShiftRow against the desktop's pinned sortable
// transition: 200ms CSS ease, with no overshoot. This is a Metal test window.
const root = createTestRoot({ width: 200, height: 160 }), store = createShiftStore()
const content = () => <div style={{ width: 200, height: 160 }}>
  <ShiftRow store={store} id="task" transition={TASK_SORT_MOTION}>
    <div testId="sibling" style={{ width: 100, height: 30, backgroundColor: '#5588aa' }} />
  </ShiftRow>
</div>
function ease(x: number) {
  const cubic = (t: number, a: number, b: number) => 3*a*t*(1-t)**2 + 3*b*t*t*(1-t) + t*t*t
  let lo = 0, hi = 1
  for (let i = 0; i < 30; i++) { const m = (lo+hi)/2; if (cubic(m,.25,.25)<x) lo=m; else hi=m }
  return cubic((lo+hi)/2,.1,1)
}
try {
  root.render(content()); const at = root.renderer.clockPause()
  const id = root.renderer.findByTestId('sibling')!.id
  const source = root.renderer.getElementBounds(id)!
  store.set(new Map([['task', 50]])); root.render(content())
  for (const ms of [0, 40, 80, 140, 200, 250]) {
    root.renderer.clockSet(at+ms); root.renderer.flush()
    const bounds = root.renderer.getElementBounds(id)!
    const progress = process.env.KYBERN_REDUCED_MOTION === '1' || ms >= 200 ? 1 : ms === 0 ? 0 : ease(ms/200)
    assert(Math.abs(bounds.y-source.y-50*progress)<1.1, `${ms}ms: sibling must follow 200ms ease`)
    assert.equal(bounds.x, source.x); assert.equal(bounds.width, source.width)
  }
  store.clear(true); root.render(content()); root.renderer.flush()
  assert.equal(root.renderer.getElementBounds(id)!.y, source.y, 'RPC layout adoption resets shifts immediately')
  console.log('PASS task sibling 200ms ease, stable layout, exact end and immediate layout-adoption reset', process.env.KYBERN_REDUCED_MOTION === '1' ? 'reduced' : 'normal')
} finally { root.unmount() }
