import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { ReactNode } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'

// The window-visibility poll reads AppKit; tests flip it directly.
let visible = true
mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => visible, onWindowVisibility: () => () => {} }))

const { Presence, EXIT } = await import('./Presence.tsx')
const { BLUR, DURATION, EASE, SCALE, Swap, SwapOnChange, enterTransform, popupOrigin, popupTransform, revealTransform } = await import('./kit.tsx')
const { arcDraw, arcKey } = await import('./success.ts')
const { hoverPressTransform, pressRowStyle, shade, PRESS_SCALE } = await import('./press.ts')
const { EASE_BOUNCE, useCountPop } = await import('../kit/Pop.tsx')
const { THEMES } = await import('../theme.ts')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
const { handleGpuixEvent } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/event-registry.js')).href)

const native = PATCHED_NATIVE ? test : test.skip

/** A renderer that records the element tree and each element's props, and can deliver `motionComplete` events. */
function harness() {
  const children = new Map<number, number[]>(), custom = new Map<number, Record<string, any>>(), style = new Map<number, Record<string, any>>(), texts = new Map<number, string>()
  let rootId = 0
  const detach = (id: number) => { for (const list of children.values()) { const at = list.indexOf(id); if (at >= 0) list.splice(at, 1) } }
  const renderer = {
    applyBatch(json: string) {
      const gone: number[] = []
      for (const [op, id, a, b] of JSON.parse(json) as [string, number, any, any][]) {
        if (op === 'createElement') { children.set(id, []); custom.set(id, {}); style.set(id, {}) }
        else if (op === 'setCustomProp') custom.get(id)![a] = b
        else if (op === 'setStyle') style.set(id, a)
        else if (op === 'setText') texts.set(id, a)
        else if (op === 'appendChild') { detach(a); children.get(id)!.push(a) }
        else if (op === 'insertBefore') { detach(a); const list = children.get(id)!; const at = list.indexOf(b); list.splice(at < 0 ? list.length : at, 0, a) }
        else if (op === 'removeChild') detach(a)
        else if (op === 'destroyElement') { detach(id); gone.push(id) }
        else if (op === 'setRoot') rootId = id
      }
      return gone
    },
    setWindowKeyEvents() {}, setWindowSelectionChange() {},
  }
  const root = createRoot(renderer)
  const walk = (id: number, out: number[] = []) => { out.push(id); for (const child of children.get(id) ?? []) walk(child, out); return out }
  const all = () => walk(rootId)
  const find = (testId: string) => all().find(id => custom.get(id)?.testId === testId)
  return {
    render: (node: ReactNode) => { flushSync(() => root.render(node)) },
    find,
    count: (testId: string) => all().filter(id => custom.get(id)?.testId === testId).length,
    transform: (testId: string) => custom.get(find(testId)!)?.paintTransform as any,
    transformOf: (id: number) => custom.get(id)?.paintTransform as any,
    style: (testId: string) => style.get(find(testId)!)!,
    texts: () => all().map(id => texts.get(id)).filter(Boolean) as string[],
    elements: () => all().filter(id => custom.get(id)?.paintTransform),
    complete: (id: number, generation: number) => flushSync(() => handleGpuixEvent({ eventType: 'motionComplete', elementId: id, motionGeneration: generation }, renderer)),
    unmount: () => root.unmount(),
  }
}

test('tokens mirror motion.css, and the old exports are aliases', () => {
  expect(DURATION.stagger).toBe(0.04)
  expect(EASE.bounce).toEqual([0.34, 1.36, 0.64, 1])
  expect(EASE.bounceStrong).toEqual([0.34, 3.85, 0.64, 1])
  expect(SCALE.medium).toBe(0.97)
  expect(BLUR.large).toBe(8)
  expect(EASE_BOUNCE).toEqual([...EASE.bounce])
  expect(PRESS_SCALE).toBe(SCALE.press)
})

test('shade multiplies RGB like brightness() and keeps alpha', () => {
  expect(shade('rgba(100, 200, 50, 0.5)', 0.96)).toBe('rgba(96, 192, 48, 0.5)')
  expect(shade('rgb(100 200 50 / 50%)', 1.08)).toBe('rgba(108, 216, 54, 0.5)')
  expect(shade('#808080', 0.5)).toBe('rgba(64, 64, 64, 1)')
  expect(shade('#fff8', 1.08)).toBe('rgba(255, 255, 255, 0.533)')
  expect(shade('rgb(250, 250, 250)', 1.08)).toBe('rgba(255, 255, 255, 1)')
  expect(shade('transparent', 0.9)).toBe('transparent')
  expect((pressRowStyle(THEMES.light, 'rgba(100, 100, 100, 1)') as any).active.backgroundColor).toBe('rgba(96, 96, 96, 1)')
  expect((pressRowStyle(THEMES.dark, 'rgba(100, 100, 100, 1)') as any).active.backgroundColor).toBe('rgba(108, 108, 108, 1)')
})

native('enter kinds start where the desktop classes start and end at rest', () => {
  const row = enterTransform('row')!
  expect(row.initial).toEqual({ opacity: 0, translateY: 4, blur: 2 })
  expect(row.animate).toEqual({ opacity: 1, translateY: 0, blur: 0 })
  expect(row.transition!.duration).toBe(0.25)
  expect(enterTransform('panel')!.initial).toEqual({ opacity: 0, translateY: 8, scale: 0.985, blur: 2 })
  expect(enterTransform('stagger', 2)!.transition!.delay).toBeCloseTo(0.14)
  expect(enterTransform('stagger', 2)!.initial).toMatchObject({ blur: 3, translateY: 12 })
  expect((enterTransform('stagger', 4)!.initial as any).blur).toBeUndefined()
  expect(enterTransform('send')!.origin).toEqual([1, 1])
  expect(enterTransform('pane')!.initial).toEqual({ opacity: 0, translateY: 4, scale: 0.995 })
  expect(enterTransform('surface')!.transition!.duration).toBe(0.16)
  expect(enterTransform('image')!.initial).toEqual({ opacity: 0, scale: 0.985, blur: 8 })
})

native('popup origin follows the trigger corner and the open values match menu.tsx / tooltip.tsx', () => {
  expect(popupOrigin('bottom', 'start')).toEqual([0, 0])
  expect(popupOrigin('bottom', 'end')).toEqual([1, 0])
  expect(popupOrigin('top', 'start')).toEqual([0, 1])
  expect(popupOrigin('right', 'center')).toEqual([0, 0.5])
  expect(popupOrigin('left', 'center')).toEqual([1, 0.5])
  expect(popupTransform([0, 0])!.initial).toEqual({ opacity: 0, scale: 0.97, blur: 2 })
  expect(popupTransform([0, 0])!.transition!.duration).toBe(0.25)
  expect(popupTransform([0, 0], 'tooltip')!.initial).toEqual({ opacity: 0, scale: 0.98 })
  expect(popupTransform([0, 0], 'tooltip')!.transition!.duration).toBe(0.15)
})

native('reveal, hover scale and arc draw', () => {
  expect(revealTransform(true)!.animate).toEqual({ opacity: 1, translateX: 0 })
  expect(revealTransform(false)!.animate).toEqual({ opacity: 0, translateX: 4 })
  expect(revealTransform(false, false)!.animate).toEqual({ opacity: 0, translateX: 0 })
  expect(revealTransform(true)!.transition!.duration).toBe(0.15)
  expect(revealTransform(false)!.transition!.duration).toBe(0.1)
  expect(hoverPressTransform(true)!.animate).toEqual({ scale: 1.05 })
  expect(hoverPressTransform(false)!.animate).toEqual({ scale: 1 })
  expect(hoverPressTransform(true)!.press!.scale).toBe(0.97)
  expect(hoverPressTransform(true, false)).toBeUndefined()
  expect(arcDraw(88)).toMatchObject({ kind: 'stroke', cycleMs: 400, delayMs: 0, dash: 88, ease: [...EASE.out] })
  expect(arcKey(61)).toBe(arcKey(62)); expect(arcKey(61)).not.toBe(arcKey(70))
})

test('useCountPop: no pop on the first render, a new key per change, the same key for the same value', () => {
  const h = harness()
  const keys: number[] = []
  function Count({ n }: { n: number }) { keys.push(useCountPop(n)); return <text>{n}</text> }
  h.render(<Count n={3} />); h.render(<Count n={3} />)
  expect(new Set(keys).size).toBe(1)
  const first = keys.at(-1)!
  h.render(<Count n={4} />)
  expect(keys.at(-1)).not.toBe(first)
  const second = keys.at(-1)!
  h.render(<Count n={4} />)
  expect(keys.at(-1)).toBe(second)
  h.unmount()
})

native('Presence keeps its children through the exit and unmounts on that generation\'s completion', () => {
  visible = true
  const h = harness()
  let gone = 0
  const view = (show: boolean, exit: { to: Record<string, number>; duration: number } = EXIT.menu) => <div testId="wrap"><Presence show={show} testId="p" exit={exit} onGone={() => gone++}><text>content</text></Presence></div>
  h.render(view(true))
  expect(h.count('p')).toBe(1)
  const enter = h.transform('p')
  expect(enter.initial).toBe(false)
  h.render(view(false))
  expect(h.count('p')).toBe(1)
  expect(h.texts()).toContain('content')
  const leave = h.transform('p')
  expect(leave.animate).toEqual({ opacity: 0, scale: 0.99 })
  expect(leave.initial).toBe(false)
  expect(leave.transition.duration).toBe(0.15)
  expect(leave.generation).not.toBe(enter.generation)
  expect(h.style('p').pointerEvents).toBe('none')
  const id = h.find('p')!
  h.complete(id, enter.generation)
  expect(h.count('p')).toBe(1)
  h.complete(id, leave.generation)
  expect(h.count('p')).toBe(0)
  expect(gone).toBe(1)
  h.unmount()
})

native('Presence: showing again mid-exit retargets to rest without restarting; entering uses the enter transform', () => {
  visible = true
  const h = harness()
  const enter = { initial: { opacity: 0, translateY: 4 }, animate: { opacity: 1, translateY: 0 }, transition: { duration: 0.25 } }
  const view = (show: boolean) => <div testId="wrap"><Presence show={show} enter={enter} testId="p" exit={EXIT.row}><text>x</text></Presence></div>
  h.render(view(true))
  expect(h.transform('p').initial).toEqual({ opacity: 0, translateY: 4 })
  expect(h.transform('p').transition.duration).toBe(0.25)
  h.render(view(false))
  const leave = h.transform('p')
  expect(leave.animate).toEqual({ opacity: 0, translateY: -4 })
  h.render(view(true))
  const back = h.transform('p')
  expect(back.initial).toBe(false)
  expect(back.animate).toMatchObject({ opacity: 1, translateY: 0 })
  expect(back.generation).not.toBe(leave.generation)
  expect(h.style('p').pointerEvents).toBeUndefined()
  h.complete(h.find('p')!, leave.generation)
  expect(h.count('p')).toBe(1)
  h.unmount()
})

native('Presence unmounts at once for a hidden window or a zero-duration (keyboard) exit', () => {
  const h = harness()
  let gone = 0
  const view = (show: boolean, exit: { to: Record<string, number>; duration: number }) => <div testId="wrap"><Presence show={show} testId="p" exit={exit} onGone={() => gone++}><text>x</text></Presence></div>
  visible = true
  h.render(view(true, EXIT.menu)); h.render(view(false, { ...EXIT.menu, duration: 0 }))
  expect(h.count('p')).toBe(0); expect(gone).toBe(1)
  h.render(view(true, EXIT.menu)); expect(h.count('p')).toBe(1)
  visible = false
  h.render(view(false, EXIT.menu))
  expect(h.count('p')).toBe(0); expect(gone).toBe(2)
  visible = true
  h.unmount()
})

native('Swap keeps the outgoing state for its exit, drops it on completion, and never holds more than two copies', () => {
  visible = true
  const h = harness()
  const view = (key: string, kind: 'text' | 'icon' = 'text') => <SwapOnChange active={key} kind={kind}><text>{key}</text></SwapOnChange>
  h.render(view('a'))
  expect(h.texts()).toEqual(['a'])
  expect(h.elements().length).toBe(0)
  h.render(view('b'))
  expect(h.texts().sort()).toEqual(['a', 'b'])
  const [out, incoming] = h.elements().map(id => h.transformOf(id)).sort((x, y) => (x.generation ? -1 : 1) - (y.generation ? -1 : 1))
  expect(out.animate).toEqual({ opacity: 0, translateY: -4, blur: 2 })
  expect(out.transition.duration).toBe(0.15)
  expect(incoming.initial).toEqual({ opacity: 0, translateY: 4, blur: 2 })
  h.render(view('c'))
  expect(h.texts().sort()).toEqual(['b', 'c'])
  const leaving = h.elements().find(id => h.transformOf(id).generation)!
  h.complete(leaving, h.transformOf(leaving).generation)
  expect(h.texts()).toEqual(['c'])
  h.unmount()
})

native('icon swaps scale and blur both ways over 250 ms in-out', () => {
  visible = true
  const h = harness()
  const view = (key: string) => <Swap active={key} kind="icon" still><text>{key}</text></Swap>
  h.render(view('a')); h.render(view('b'))
  const transforms = h.elements().map(id => h.transformOf(id))
  const out = transforms.find(t => t.generation)!
  expect(out.animate).toEqual({ opacity: 0, scale: 0.6, blur: 2 })
  expect(out.transition.duration).toBe(0.25)
  expect(transforms.find(t => !t.generation)!.initial).toEqual({ opacity: 0, scale: 0.6, blur: 2 })
  h.unmount()
})
