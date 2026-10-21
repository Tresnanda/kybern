// The desktop's motion tokens (`apps/desktop/src/styles/motion.css:13-74`) as numbers. A leaf module on purpose:
// `ui.tsx` -> `motion/press.ts` -> `motion/kit.tsx` -> `ui.tsx` is an import cycle, so anything that needs a token while
// its own module evaluates (`PRESS_SCALE`, `EASE_BOUNCE`, `EASE_OUT`) reads it from here. `motion/kit.tsx` re-exports all
// of it; application code imports from there.

/** `--duration-*` in seconds (`stagger` is `--stagger-step`, `spring` is `--duration-spring`). */
export const DURATION = { stagger: 0.04, micro: 0.08, quick: 0.15, fast: 0.25, medium: 0.35, slow: 0.4, verySlow: 0.5, spring: 0.45 } as const

/** `--ease-*` cubic-bezier control points. */
export const EASE = {
  smoothOut: [0.22, 1, 0.36, 1],
  out: [0.23, 1, 0.32, 1],
  inOut: [0.77, 0, 0.175, 1],
  drawer: [0.32, 0.72, 0, 1],
  /** A critically damped spring (response .4 s, damping 1) over `slow`: the shared-element image morph (`ImageMorph.tsx`). */
  morph: [0.2, 0.15, 0.25, 1],
  bounce: [0.34, 1.36, 0.64, 1],
  bounceStrong: [0.34, 3.85, 0.64, 1],
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>

/** `--distance-*` in px. */
export const DISTANCE = { micro: 4, small: 6, base: 8, medium: 12 } as const

/** `--scale-*`. */
export const SCALE = { large: 0.96, medium: 0.97, small: 0.98, tiny: 0.99, press: 0.97 } as const

/** `--blur-*` in px (`large` is `t-img`'s starting blur). */
export const BLUR = { small: 2, medium: 3, large: 8 } as const

/**
 * `transition-colors` for hover and press-release fills (the desktop's 150 ms, kept under 100 ms because hover is a
 * tens-per-day action): the native `hoverTransition` declared once at each window's root. A press itself lands at once.
 */
export const HOVER_FADE = { duration: 0.09, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] } as const

/** `DISCLOSURE_TRANSITION_MS`. */
export const DISCLOSURE = 0.22

/** `--ease-spring` + `--duration-spring` (response .35 s, bounce .15) as the native spring. */
export const SPRING = { type: 'spring', duration: 0.45, bounce: 0.15 } as const

export type Ease = readonly [number, number, number, number]
