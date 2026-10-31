// A visual's resting picture (ADE-69): the daemon draws the page headlessly at the figure's width in this theme, on a
// transparent background, with the boxes of its controls (`threads.visuals.snapshot`). The PNGs reach the native <img>
// as cached files (`imageFiles.ts`). One request per picture: the figure, its tab and a remount share it.
import { useEffect, useState } from 'react'
import type { HtmlSnapshotResult, JsonValue, VisualControl } from '../../../../packages/kybern-client/src/types.ts'
import type { VisualTheme } from '../../../../packages/kybern-client/src/visuals.ts'
import { threadClient } from '../state.ts'
import { useEnvironment } from '../shell/environment.ts'
import { storeImageBytes } from './imageFiles.ts'

export interface Picture {
  /** The whole page, `height` CSS pixels tall. */
  path: string
  /** The page cut at `clamp` with its last 112 px fading to transparent (tall pages only). */
  fade: string | null
  width: number
  height: number
  clamp: number
  controls: VisualControl[]
}

const ENTRIES = 128
const cache = new Map<string, Picture>()
const loading = new Map<string, Promise<Picture>>()

async function fetchPng(threadId: string, visualId: string, file: string): Promise<string> {
  const client = threadClient(threadId)
  if (!client) throw Error('Kybern is not connected.')
  const response = await client.fetch(`/threads/${encodeURIComponent(threadId)}/visuals/${encodeURIComponent(visualId)}/snapshot/${file}`)
  if (!response.ok) throw Error(`The picture did not load (${response.status}).`)
  return storeImageBytes(new Uint8Array(await response.arrayBuffer()), 'image/png')
}

export function pictureKey(visualId: string, width: number, theme: VisualTheme, lock: JsonValue | null) {
  return `${visualId}:${width}:${JSON.stringify(theme)}:${lock === null ? '' : JSON.stringify(lock)}`
}

export function loadPicture(threadId: string, visualId: string, width: number, theme: VisualTheme, lock: JsonValue | null): Promise<Picture> {
  const key = pictureKey(visualId, width, theme, lock)
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const running = loading.get(key)
  if (running) return running
  let client: ReturnType<typeof threadClient>
  try { client = threadClient(threadId) } catch (e) { return Promise.reject(e) }
  if (!client) return Promise.reject(Error('Kybern is not connected.'))
  const request = client.call('threads.visuals.snapshot', { thread_id: threadId, visual_id: visualId, width, theme: theme as unknown as JsonValue, lock })
    .then(async (result: HtmlSnapshotResult) => {
      const [path, fade] = await Promise.all([fetchPng(threadId, visualId, `${result.key}.png`), result.clamped ? fetchPng(threadId, visualId, `${result.key}-fade.png`) : Promise.resolve(null)])
      const picture: Picture = { path, fade, width: result.width, height: result.height, clamp: result.clamp, controls: result.controls }
      cache.delete(key); cache.set(key, picture)
      while (cache.size > ENTRIES) cache.delete(cache.keys().next().value!)
      return picture
    })
    .finally(() => loading.delete(key))
  loading.set(key, request)
  return request
}

/** The picture at `width` (null until the figure is measured). A width change keeps the last picture until the new one loads. */
export function usePicture(threadId: string, visualId: string, width: number | null, theme: VisualTheme, lock: JsonValue | null) {
  const environment = useEnvironment()
  const key = width ? pictureKey(visualId, width, theme, lock) : null
  const [state, setState] = useState<{ key: string | null; picture: Picture | null; error: string; attempt: number }>(() => ({ key, picture: key ? cache.get(key) ?? null : null, error: '', attempt: 0 }))
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!key || !width) return
    const hit = cache.get(key)
    if (hit) { setState(s => (s.picture === hit ? s : { key, picture: hit, error: '', attempt })); return }
    let alive = true
    setState(s => ({ ...s, key, error: '' }))
    loadPicture(threadId, visualId, width, theme, lock).then(
      picture => { if (alive) setState({ key, picture, error: '', attempt }) },
      error => { if (alive) setState(s => ({ ...s, key, error: String(error?.message ?? error) })) },
    )
    return () => { alive = false }
    // `theme` and `lock` are part of `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, threadId, visualId, attempt, environment.revision])
  return {
    picture: state.picture,
    /** The current key failed and there is no picture to keep showing. */
    error: state.picture ? '' : state.error,
    loading: !state.picture && !state.error,
    retry: () => { if (key) cache.delete(key); setAttempt(n => n + 1) },
  }
}
