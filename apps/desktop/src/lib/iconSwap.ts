export type IconSwapKey = "a" | "b"

export type IconSwapState = {
  shown: IconSwapKey
  leaving: IconSwapKey | null
}

export const ICON_SWAP_TRANSITION_MS = 250

export function advanceIconSwap(state: IconSwapState, active: IconSwapKey): IconSwapState {
  if (state.shown === active) return state
  return { shown: active, leaving: state.shown }
}

/** Ignore a stale exit timer when the swap has reversed since it was scheduled. */
export function settleIconSwap(state: IconSwapState, shown: IconSwapKey): IconSwapState {
  if (state.shown !== shown || state.leaving === null) return state
  return { shown, leaving: null }
}
