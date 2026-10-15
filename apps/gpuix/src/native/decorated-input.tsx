import { useGpuixRequired, type TextareaProps } from '@gpuix/react'
import { useEffect, useRef } from 'react'
import { decoratedInputCapabilities, type InputDecoration } from './api.ts'
import { observeElementBounds } from './layout.ts'

/** Keeps the ordinary native editor/ref/undo model. testId must be unique. */
export function DecoratedTextarea({ decorations, ...props }: TextareaProps & { testId: string; value: string; decorations: InputDecoration[] }) {
  const renderer = useGpuixRequired()
  const mounted = useRef<number | null>(null)
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
    const stop = observeElementBounds(renderer, { testId: props.testId }, event => {
      mounted.current = event.rect ? event.elementId : null
      if (mounted.current != null) currentApply.current()
    })
    return () => { mounted.current = null; stop() }
  }, [renderer, props.testId])
  const encoded = JSON.stringify(decorations)
  useEffect(apply, [renderer, props.value, encoded])
  return <textarea {...props} onKeyUp={event => { props.onKeyUp?.(event); apply() }} />
}
