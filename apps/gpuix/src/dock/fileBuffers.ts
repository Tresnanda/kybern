// Unsaved file edits (ADE-61). A file tab's text lives here, not in the editor, so it survives switching tabs (only the active
// tab of a group is mounted). One buffer per file: a project file shown in two groups, or in two threads' tabs, is one buffer.
// Listeners hear only state changes (dirty, saving, a conflict), never keystrokes: the text itself is read on demand.
import { useSyncExternalStore } from 'react'
import type { FilesReadResult } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'

/** Where a file is read and saved: a project (`files.*`) or a thread's workspace (`threads.files.*`). */
export type FileRoot = { projectId: string } | { threadId: string }
export const bufferOwner = (root: FileRoot) => 'projectId' in root ? `p:${root.projectId}` : `t:${root.threadId}`
export const bufferKey = (root: FileRoot, path: string) => `${bufferOwner(root)}\0${path}`

/** Largest file the editor opens for editing (the daemon's write limit and the syntax limit). */
export const EDITABLE_BYTES = 2 * 1024 * 1024

export interface FileBuffer {
  root: FileRoot
  path: string
  /** The text on disk this buffer is based on (what Save compares against). */
  base: string
  /** The disk version `base` came from; a save sends it so a newer file on disk is never overwritten silently. */
  version: string | null
  text: string
  dirty: boolean
  saving: boolean
  /** The file changed on disk while there were unsaved edits. */
  conflict: { content: string; version: string | null } | null
  error: string | null
}

const buffers = new Map<string, FileBuffer>()
const listeners = new Set<() => void>()
let generation = 0
const emit = () => { generation++; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export const getBuffer = (key: string) => buffers.get(key)
/** Re-renders when any buffer's state changes; read the buffer itself with `getBuffer`. */
export function useBufferState(key: string | null) {
  useSyncExternalStore(subscribe, () => generation)
  return key ? buffers.get(key) : undefined
}
/** Whether a buffer has unsaved edits. Re-renders only when that answer changes. */
export function useBufferDirty(key: string | null): boolean {
  return useSyncExternalStore(subscribe, () => !!key && !!buffers.get(key)?.dirty)
}
/** The keys of every buffer with unsaved edits, as one string (a stable snapshot). */
export function useDirtyKeys(): string {
  return useSyncExternalStore(subscribe, () => [...buffers.values()].filter((b) => b.dirty).map((b) => bufferKey(b.root, b.path)).join('\n'))
}

/** The buffer for a read, created from it the first time. */
export function openBuffer(root: FileRoot, path: string, file: FilesReadResult): FileBuffer {
  const key = bufferKey(root, path)
  const existing = buffers.get(key)
  if (existing) return existing
  const created: FileBuffer = { root, path, base: file.content, version: file.version ?? null, text: file.content, dirty: false, saving: false, conflict: null, error: null }
  buffers.set(key, created)
  emit()
  return created
}

function patch(key: string, next: Partial<FileBuffer>) {
  const buffer = buffers.get(key)
  if (!buffer) return
  const dirty = next.dirty ?? buffer.dirty
  Object.assign(buffer, next, { dirty })
  emit()
}

/** Typing: records the text; notifies only when the buffer turns dirty or clean. */
export function setBufferText(key: string, text: string) {
  const buffer = buffers.get(key)
  if (!buffer) return
  buffer.text = text
  const dirty = text !== buffer.base
  if (dirty !== buffer.dirty) { buffer.dirty = dirty; emit() }
}

/**
 * A fresh read of the file. A clean buffer follows the disk (returns the text to show); a dirty one keeps its edits and records a
 * conflict, unless the disk still holds the same text it was based on.
 */
export function adoptRead(key: string, file: FilesReadResult): string | null {
  const buffer = buffers.get(key)
  if (!buffer || file.unchanged || file.binary || file.truncated) return null
  const version = file.version ?? null
  if (file.content === buffer.base) {
    if (version !== buffer.version) patch(key, { version, conflict: null })
    return null
  }
  if (!buffer.dirty || file.content === buffer.text) {
    patch(key, { base: file.content, version, text: file.content, dirty: false, conflict: null })
    return file.content
  }
  if (buffer.conflict?.version !== version) patch(key, { conflict: { content: file.content, version } })
  return null
}

/** "Reload": take the disk's text, dropping the unsaved edits. Returns the text to show. */
export function reloadBuffer(key: string): string | null {
  const conflict = buffers.get(key)?.conflict
  if (!conflict) return null
  patch(key, { base: conflict.content, version: conflict.version, text: conflict.content, dirty: false, conflict: null, error: null })
  return conflict.content
}

/** "Keep mine": the edits stay, and the next save replaces the newer file on disk. */
export function keepMine(key: string) {
  const buffer = buffers.get(key)
  if (!buffer?.conflict) return
  patch(key, { base: buffer.conflict.content, version: buffer.conflict.version, dirty: buffer.text !== buffer.conflict.content, conflict: null })
}

export function readFile(root: FileRoot, path: string, ifVersion?: string | null): Promise<FilesReadResult> {
  const client = getClient()!
  const if_version = ifVersion ?? undefined
  return 'projectId' in root
    ? client.call('files.read', { project_id: root.projectId, path, max_bytes: EDITABLE_BYTES, if_version })
    : client.call('threads.files.read', { thread_id: root.threadId, path, max_bytes: EDITABLE_BYTES, if_version })
}

const CONFLICT = -32004
/** ⌘S. A file that changed on disk since the buffer's version is not overwritten: the conflict bar offers Reload / Keep mine. */
export async function saveBuffer(key: string): Promise<boolean> {
  const buffer = buffers.get(key)
  if (!buffer || buffer.saving || buffer.conflict) return false
  const text = buffer.text
  patch(key, { saving: true, error: null })
  const client = getClient()!
  const params = { path: buffer.path, content: text, expected_version: buffer.version ?? undefined }
  try {
    const saved = 'projectId' in buffer.root
      ? await client.call('files.write', { project_id: buffer.root.projectId, ...params })
      : await client.call('threads.files.write', { thread_id: buffer.root.threadId, ...params })
    const now = buffers.get(key)
    patch(key, { saving: false, base: text, version: saved.version, dirty: !!now && now.text !== text })
    return true
  } catch (error) {
    if ((error as { code?: number }).code === CONFLICT || /changed on disk/.test(String(error))) {
      patch(key, { saving: false })
      try {
        const file = await readFile(buffer.root, buffer.path)
        patch(key, { conflict: { content: file.content, version: file.version ?? null } })
      } catch { patch(key, { error: 'The file changed on disk. Reload it to see the new version.' }) }
      return false
    }
    patch(key, { saving: false, error: `Unable to save ${buffer.path.split('/').pop()}. ${String((error as Error).message ?? error)}` })
    return false
  }
}

/** Close without saving ("Don't save"): the buffer goes; the next open reads the file again. */
export function discardBuffer(key: string) {
  if (buffers.delete(key)) emit()
}

// Clean buffers of closed or hidden tabs are kept for the last few files, so switching back shows the editor at once.
const KEEP_CLEAN = 8
const released: string[] = []
/** The tab stopped showing this buffer. A dirty buffer always stays; clean ones beyond the last few go. */
export function releaseBuffer(key: string) {
  const index = released.indexOf(key)
  if (index >= 0) released.splice(index, 1)
  released.push(key)
  let removed = false
  while (released.length > KEEP_CLEAN) {
    const oldest = released.shift()!
    if (buffers.get(oldest)?.dirty) continue
    removed = buffers.delete(oldest) || removed
  }
  if (removed) emit()
}
