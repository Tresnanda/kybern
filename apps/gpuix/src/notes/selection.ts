import { useEffect, useRef, useState } from 'react'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { nativeCapabilities } from '../native/api.ts'
import { toast } from '../shell/toasts.tsx'

import { markRange } from './selectionRange.ts'

/** Event-driven selection reads; no idle timer. Native edits retain one undo step. */
export function useMarkdownSelection(value: string) {
  const { renderer } = useGpuix()
  const ref = useRef<PublicInstance>(null)
  const [selected, setSelected] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const refresh = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!renderer || !ref.current) return
      try { const range = nativeCapabilities(renderer).getInputSelection(ref.current.id); setSelected(range.end > range.start && !range.composing) } catch { setSelected(false) }
    }, 0)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const apply = (link: { label: string; href: string } | string) => {
    if (!renderer || !ref.current) return false
    try {
      const api = nativeCapabilities(renderer), range = api.getInputSelection(ref.current.id)
      if (range.composing) return false
      const { start, end } = range
      const change = typeof link === 'string' ? markRange(value, start, end, link) : {
        start, end,
        text: `[${(value.slice(start, end) || link.label || link.href).replace(/[\\[\]]/g, '\\$&')}](${encodeURI(link.href).replaceAll('(', '%28').replaceAll(')', '%29')})`,
        selectionStart: start, selectionEnd: start,
      }
      api.editInput(ref.current.id, { start: change.start, end: change.end, text: change.text, expectedValue: value })
      api.setInputSelection(ref.current.id, change.selectionStart, change.selectionEnd, range.reversed)
      renderer.focusElement?.(ref.current.id)
      refresh()
      return true
    } catch { toast.error('Couldn’t format selection', { description: 'Select the text again and retry.' }); return false }
  }
  return { ref, refresh, selected, mark: (marker: string) => apply(marker), link: (label: string, href: string) => apply({ label, href }) }
}
