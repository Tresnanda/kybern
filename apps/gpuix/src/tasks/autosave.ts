import { useEffect, useRef, useState } from 'react'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { updateTask, upsert } from './store.ts'

/** One serialized content queue: debounced body, blur-committed title, revision checks. */
export function useTaskAutosave(task: TaskItem) {
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState(task.body)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const state = useRef({
    title: task.title,
    body: task.body,
    revision: task.revision,
    titleDirty: false,
    bodyDirty: false,
    pending: 0,
    live: true,
  })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const chain = useRef(Promise.resolve())
  useEffect(() => {
    const s = state.current
    if (s.pending) return
    s.revision = task.revision
    if (!s.titleDirty) {
      s.title = task.title
      setTitle(task.title)
    }
    if (!s.bodyDirty) {
      s.body = task.body
      setBody(task.body)
    }
  }, [task])
  function flush() {
    clearTimeout(timer.current)
    const s = state.current
    if (!s.titleDirty && !s.bodyDirty) return chain.current
    const patch = { ...(s.titleDirty ? { title: s.title } : {}), ...(s.bodyDirty ? { body: s.body } : {}) }
    s.titleDirty = false
    s.bodyDirty = false
    s.pending++
    if (s.live) {
      setSaving(true)
      setError(null)
    }
    chain.current = chain.current.then(async () => {
      try {
        const saved = await updateTask(task.id, { ...patch, expected_revision: s.revision })
        s.revision = saved.revision
      } catch (e) {
        // Keep edits on a connection failure. A conflict reloads the authoritative content.
        if (String(e).toLowerCase().includes('conflict') || String(e).toLowerCase().includes('revision')) {
          const latest = await getClient()
            ?.call('tasks.items.get', { id: task.id })
            .catch(() => null)
          if (latest?.task) {
            upsert(latest.task)
            s.revision = latest.task.revision
            if (!s.titleDirty) {
              s.title = latest.task.title
              if (s.live) setTitle(s.title)
            }
            if (!s.bodyDirty) {
              s.body = latest.task.body
              if (s.live) setBody(s.body)
            }
          }
          if (s.live) setError('This task changed elsewhere. The latest version is shown; review it before editing again.')
        } else {
          if (patch.title !== undefined) s.titleDirty = true
          if (patch.body !== undefined) s.bodyDirty = true
          if (s.live) setError('Your edits are kept here. Reconnect, then retry saving.')
        }
      } finally {
        s.pending--
        if (s.live && !s.pending) setSaving(false)
      }
    })
    return chain.current
  }
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      state.current.live = false
      void flush()
    },
    [],
  )
  return {
    title,
    body,
    error,
    saving,
    flush,
    editTitle(value: string) {
      state.current.title = value
      state.current.titleDirty = true
      setTitle(value)
    },
    editBody(value: string) {
      state.current.body = value
      state.current.bodyDirty = true
      setBody(value)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        void flush()
      }, 700)
    },
  }
}
