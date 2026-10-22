import {backdropAllowed, onAccessibilityDisplay} from '../platform/material.ts'

// Scene backdrops follow Reduce transparency and Increase contrast live
// (`platform/material.ts`). `BACKDROP_ALLOWED` is a live binding, updated
// before React re-renders: those options are part of the theme, so a change
// re-renders every themed view, which then reads the new value.
export let BACKDROP_ALLOWED = backdropAllowed()
onAccessibilityDisplay(() => { BACKDROP_ALLOWED = backdropAllowed() })
/** Theme colors are resolved rgb()/rgba()/hex before reaching native styles. */
export function backdropTint(color: string, alpha = 0.78): string {
  if (color.startsWith('#')) {
    const raw=color.slice(1),hex=raw.length<=4?[...raw].map(c=>c+c).join(''):raw
    return `rgba(${parseInt(hex.slice(0,2),16)},${parseInt(hex.slice(2,4),16)},${parseInt(hex.slice(4,6),16)},${alpha})`
  }
  const values=color.match(/^rgba?\(([^)]+)\)$/)?.[1]?.split(/[\s,/]+/).filter(Boolean)
  return values?.length && values.length>=3?`rgba(${values[0]},${values[1]},${values[2]},${alpha})`:color
}
