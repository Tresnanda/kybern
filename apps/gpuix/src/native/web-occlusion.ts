import { createContext, useContext, useLayoutEffect, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import { observeElementBounds } from './layout.ts'
import { webHost } from './webview.ts'

// Child web surfaces in a modal belong above that modal's backing, while
// ordinary document surfaces are cut out beneath every GPUI popup.
export const WebLayer = createContext(0)
export const useWebLayer = () => useContext(WebLayer)
let nextLayer = 0
export function useWebOcclusion(testId?: string, radius = 0, dim = 0, inputOnly = false) {
  const renderer = useGpuixRequired()
  const [layer] = useState(() => ++nextLayer)
  const id = testId ?? `web-occlusion-${layer}`
  useLayoutEffect(() => {
    const stop = observeElementBounds(renderer, { testId: id }, event => webHost.occlusion(layer, event.clippedRect, radius, dim, layer, inputOnly))
    return () => { stop(); webHost.occlusion(layer, null) }
  }, [renderer, id, layer, radius, dim, inputOnly])
  return { id, layer }
}
