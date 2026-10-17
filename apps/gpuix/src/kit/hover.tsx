// React side of `hoverController.ts`: `useHover` owns one controller per popup, `HoverScope`
// lets a tooltip inside a card open without closing it, and `hoverTrigger` composes the
// pointer, press and focus handlers onto a trigger element.
import { cloneElement, createContext, useContext, useEffect, useReducer, useRef, type ReactElement, type ReactNode } from 'react'
import { HoverController, type HoverOptions } from './hoverController.ts'

export const HoverScope = createContext<HoverController<unknown> | null>(null)

export interface HoverState<K> {
  /** What the popup shows for, or null while closed. */
  active: K | null
  /** Skip the entrance motion (opened right after a neighbour closed, or carried to another trigger). */
  instant: boolean
  carried: boolean
}

/** One controller for one popup (or one shared card with many triggers, keyed by `K`). */
export function useHover<K = true>(options: Omit<HoverOptions, 'parent'>): { ctl: HoverController<K>; state: HoverState<K> } {
  const parent = useContext(HoverScope)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const ref = useRef<HoverController<K> | null>(null)
  if (!ref.current) ref.current = new HoverController<K>({ ...options, parent }, bump as () => void)
  const ctl = ref.current
  ctl.options = { ...options, parent }
  // Unmounting a trigger (a row that scrolled away, a rebuilt rail) releases the global slot.
  useEffect(() => () => ctl.dispose(), [ctl])
  return { ctl, state: { active: ctl.active, instant: ctl.instant, carried: ctl.carried } }
}

type Handler = (event: never) => void
const compose = (first: Handler | undefined, second: Handler): Handler => (event) => {
  first?.(event)
  second(event)
}

/**
 * Props that make `element` the trigger for `key`: hover opens after the delay and
 * leaving closes (an enter and a leave inside one frame still close), a press or
 * Escape closes, keyboard focus opens at once (tooltips; cards ignore focus like `PreviewCard`). The element keeps its own handlers.
 */
export function hoverTrigger<K>(ctl: HoverController<K>, key: K, element: ReactElement, press = { current: false }, focusOpens = true) {
  const p = element.props as Record<string, Handler | undefined>
  return cloneElement(element as ReactElement<Record<string, unknown>>, {
    onMouseEnter: compose(p.onMouseEnter, () => ctl.enter(key)),
    onMouseLeave: compose(p.onMouseLeave, () => {
      press.current = false
      ctl.leave(key)
    }),
    onMouseDown: compose(p.onMouseDown, () => {
      press.current = true
      ctl.hide()
    }),
    onClick: compose(p.onClick, () => ctl.hide()),
    // A click focuses the trigger; that must not reopen what the press just closed.
    onFocus: compose(p.onFocus, () => {
      if (focusOpens && !press.current) ctl.openNow(key)
    }),
    onBlur: compose(p.onBlur, () => ctl.hide()),
    onKeyDown: compose(p.onKeyDown, ((event: { key?: string }) => {
      if (event.key === 'escape') ctl.hide()
    }) as Handler),
  })
}

/** Wrap a popup's content so tooltips inside it don't close it. */
export function HoverScopeProvider({ ctl, children }: { ctl: HoverController<unknown>; children: ReactNode }) {
  return <HoverScope.Provider value={ctl}>{children}</HoverScope.Provider>
}
