import { useEffect, useRef, useState } from 'react'

/** True for 1.5 s after `flash()` (a copied link, a finished merge). */
export function useFlash(ms = 1500) {
  const [on, setOn] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return [on, () => { setOn(true); clearTimeout(timer.current); timer.current = setTimeout(() => setOn(false), ms) }] as const
}
