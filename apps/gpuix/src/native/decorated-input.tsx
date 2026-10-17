import { useGpuixRequired, type PublicInstance, type TextareaProps } from '@gpuix/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { decoratedInputCapabilities, type InputDecoration } from './api.ts'
import { observeElementBounds } from './layout.ts'

/** Keeps the ordinary native editor/ref/undo model. Observes its own node, so several can share a testId (split panes). */
export function DecoratedTextarea({ decorations, ...props }: TextareaProps & { testId: string; value: string; decorations: InputDecoration[] }) {
  const renderer = useGpuixRequired()
  const mounted = useRef<number | null>(null)
  const [node, setNode] = useState<PublicInstance | null>(null)
  const latest = useRef({ value: props.value, decorations })
  latest.current = { value: props.value, decorations }
  const apply = () => {
    if (mounted.current == null) return
    try {
      decoratedInputCapabilities(renderer).setInputDecorations(mounted.current, latest.current.decorations, latest.current.value)
    } catch (error) {
      // Native typing can outrun React; composition owns the buffer until commit.
      // onChange/effect and key-up retry with the current value, without polling.
      if (!/Input changed before decorations|Input is secure or composing|Input is not mounted/.test(String(error))) throw error
    }
  }
  const currentApply = useRef(apply)
  currentApply.current = apply
  useEffect(() => {
    if (!node) return
    const stop = observeElementBounds(renderer, node.id, event => {
      mounted.current = event.rect ? event.elementId : null
      if (mounted.current != null) currentApply.current()
    })
    return () => { mounted.current = null; stop() }
  }, [renderer, node])
  const encoded = JSON.stringify(decorations)
  useEffect(apply, [renderer, props.value, encoded])
  // One stable callback: forwards to the caller's ref and records our own node.
  const outer = useRef<unknown>(null)
  outer.current = (props as { ref?: unknown }).ref
  const ref = useCallback((el: PublicInstance | null) => {
    setNode(el)
    const forward = outer.current
    if (typeof forward === 'function') forward(el)
    else if (forward && typeof forward === 'object') (forward as { current: unknown }).current = el
  }, [])
  return <textarea {...props} ref={ref} onKeyUp={event => { props.onKeyUp?.(event); apply() }} />
}
