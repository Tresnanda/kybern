/** Spring settings shared by every drag interaction. `duration` is seconds, `bounce` 0..1 (README: native springs). */
export const SPRING = {
  /** Siblings making room: quick, barely any overshoot. */
  shift: { type: 'spring' as const, duration: 0.3, bounce: 0.05 },
  /** The dragged item landing: a little life, carries the release velocity. */
  land: { type: 'spring' as const, duration: 0.4, bounce: 0.14 },
  /** Returning home after Escape or an invalid drop: critically damped, no flourish. */
  home: { type: 'spring' as const, duration: 0.36, bounce: 0 },
}
/** Pickup lift in px: GPUIX has no subtree scale, so the ghost grows by this much and its shadow fades in. */
export const LIFT = { grow: 8, growY: 6, shadowMs: 0.14 }
