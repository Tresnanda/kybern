import { useEffect, useRef, useState } from 'react'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { load, save } from '../shell/persist.ts'
import { upsert } from './store.ts'

/** One serialized content queue: debounced body, blur-committed title, revision checks. */
export function useTaskAutosave(task: TaskItem) {
  const key = `kybern.tasks.draft:${task.id}`
  const [draft] = useState(() => load<{ title: string; body: string; revision: number } | null>(key, null))
  const owner = useRef(activeEnvironment()).current
  const client = useRef(getClient()).current
  const [title, setTitle] = useState(draft?.title ?? task.title)
  const [body, setBody] = useState(draft?.body ?? task.body)
  const initialConflict = draft && draft.revision !== task.revision ? task : null
  const [conflict, setConflict] = useState<TaskItem | null>(initialConflict)
  const conflictRef = useRef<TaskItem | null>(initialConflict)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const state = useRef({
    title: draft?.title ?? task.title,
    body: draft?.body ?? task.body,
    revision: draft?.revision ?? task.revision,
    titleDirty: !!draft && draft.title !== task.title,
    bodyDirty: !!draft && draft.body !== task.body,
    pending: 0,
    live: true,
  })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const chain = useRef(Promise.resolve())
  useEffect(() => {
    const s = state.current
    if (s.pending || conflictRef.current) return
    if (!s.titleDirty && !s.bodyDirty) s.revision = task.revision
    if (!s.titleDirty) {
      s.title = task.title
      setTitle(task.title)
    }
    if (!s.bodyDirty) {
      s.body = task.body
      setBody(task.body)
    }
  }, [task])
  function persist() {
    if (owner !== activeEnvironment()) return
    const s = state.current
    save(key, { title: s.title, body: s.body, revision: s.revision })
  }
  function flush() {
    clearTimeout(timer.current)
    const s = state.current
    if (owner !== activeEnvironment() || conflictRef.current || (!s.titleDirty && !s.bodyDirty)) return chain.current
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
        if (owner !== activeEnvironment()) return
        if (conflictRef.current) { if (patch.title !== undefined) s.titleDirty = true; if (patch.body !== undefined) s.bodyDirty = true; persist(); return }
        if (!client) throw Error('Reconnect to save your task.')
        const saved = await client.call('tasks.items.update', { id: task.id, ...patch, expected_revision: s.revision })
        s.revision = saved.revision
        if (owner === activeEnvironment()) {
          upsert(saved)
          if (!s.titleDirty && !s.bodyDirty && s.pending === 1) save(key, undefined)
          else persist()
        }
      } catch (e) {
        if (owner !== activeEnvironment()) return
        if (patch.title !== undefined) s.titleDirty = true
        if (patch.body !== undefined) s.bodyDirty = true
        persist()
        if ((e as { code?: number }).code === -32004 || /conflict|revision/i.test(String(e))) {
          const latest = await client?.call('tasks.items.get', { id: task.id }).catch(() => null)
          if (latest?.task && owner === activeEnvironment()) {
            conflictRef.current = latest.task
            if (s.live) setConflict(latest.task)
          }
          if (s.live) setError('This task changed elsewhere. Your edits are kept. Choose which version to use.')
        } else if (s.live) setError('Your edits are kept here. Reconnect, then retry saving.')
      } finally {
        s.pending--
        if (s.live && !s.pending) setSaving(false)
      }
    })
    return chain.current
  }
  useEffect(() => { if (draft && !conflictRef.current) void flush() }, [])
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
    conflict,
    useTheirs() {
      const latest = conflictRef.current
      if (!latest) return
      const s = state.current
      s.title = latest.title; s.body = latest.body; s.revision = latest.revision
      s.titleDirty = false; s.bodyDirty = false
      conflictRef.current = null; setConflict(null); setError(null)
      setTitle(s.title); setBody(s.body); upsert(latest); save(key, undefined)
    },
    keepMine() {
      const latest = conflictRef.current
      if (!latest) return
      state.current.revision = latest.revision
      conflictRef.current = null; setConflict(null); setError(null)
      persist(); void flush()
    },
    flush,
    editTitle(value: string) {
      state.current.title = value
      state.current.titleDirty = true
      setTitle(value)
      persist()
    },
    editBody(value: string) {
      state.current.body = value
      state.current.bodyDirty = true
      setBody(value)
      persist()
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        void flush()
      }, 700)
    },
  }
}
