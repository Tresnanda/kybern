import { imageSource } from '../../../../packages/kybern-client/src/responseImages.ts'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdir, readFile, rename, writeFile, access, open, unlink } from 'node:fs/promises'
import { getState, machineOfThreadId, requireThreadClient, ownProjectId } from '../state.ts'
import { machineHub } from '../machines/index.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { downloadsDir, openTarget, revealPath } from '../platform/os.ts'
import { toast } from '../shell/toasts.tsx'
import { toastProblem } from '../problems/toast.ts'
import { showFileInExplorer } from '../dock/explorerSelection.ts'

export const threadFilesAreLocal = (id: string) => activeEnvironment().local && !machineOfThreadId(id)
export function absoluteThreadFile(id: string, file: string, root: 'thread' | 'project' = 'thread'): string | null {
  if (file.startsWith('file://')) file = imageSource(file)?.value ?? file
  if (threadFilesAreLocal(id) && file.startsWith('~/')) file = path.join(homedir(), file.slice(2))
  const thread = getState().threads.find(th => th.id === id) ?? (getState().open.thread?.id === id ? getState().open.thread : undefined)
  let cwd = thread?.cwd
  if (root === 'project' && thread) {
    const hub = machineHub(), machine = machineOfThreadId(id) ?? hub.localMachineId
    cwd = hub.view().projects.flatMap(p => p.instances).find(p => p.machineId === machine && p.project.id === ownProjectId(thread))?.project.path
      ?? getState().projects.find(p => p.id === thread.project_id)?.path ?? cwd
  }
  const p = /^[a-z]:[\\/]/i.test(cwd ?? file) ? path.win32 : path.posix
  return p.isAbsolute(file) ? file : cwd ? p.resolve(cwd, file) : null
}
export function showThreadFile(id: string, file: string) {
  const thread = getState().threads.find(th => th.id === id)
  const absolute = absoluteThreadFile(id, file)
  if (thread && absolute) showFileInExplorer(id, thread.project_id, absolute)
}
const pending = new Map<string, Promise<string>>()
async function downloadFile(id: string, file: string): Promise<string> {
  const machine = machineOfThreadId(id), hub = machineHub()
  const name = machine ? hub.set.displayName(machine) : activeEnvironment().name
  const safe = (part: string) => part.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_')
  const parts = file.replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..').map(safe)
  const target = path.join(downloadsDir(), 'Kybern', safe(name), ...parts)
  await mkdir(path.dirname(target), { recursive: true })
  let etag: string | undefined
  const identity = `${machine}:${id}:${file}`
  try { await access(target); const saved = JSON.parse(await readFile(target + '.kybern-etag', 'utf8')); if (saved.identity === identity) etag = saved.etag } catch {}
  const response = await requireThreadClient(id).fetch(`/threads/${encodeURIComponent(id)}/file?path=${encodeURIComponent(file)}`, { headers: etag ? { 'If-None-Match': etag } : {} })
  if (response.status === 304) return target
  if (!response.ok || !response.body) throw Error('Unable to download the file. Check that the machine is connected and the file is allowed, then retry.')
  const notice = `download:${id}:${file}`
  const total = Number(response.headers.get('content-length'))
  const partial = `${target}.${randomUUID()}.kybern-part`
  const output = await open(partial, 'wx')
  const reader = response.body.getReader()
  let bytes = 0, last = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      await output.writeFile(next.value); bytes += next.value.length
      if (Date.now() - last > 250 && bytes > 1024 * 1024) { last = Date.now(); toast(`Downloading ${path.basename(target)}…${total ? ` ${Math.round(bytes / total * 100)}%` : ''}`, { id: notice, duration: Infinity }) }
    }
    await output.close()
    await rename(partial, target)
    await writeFile(target + '.kybern-etag', JSON.stringify({ identity, etag: response.headers.get('etag') ?? '' }))
    toast.dismiss(notice)
    toast(`Downloaded a copy from ${name}. Changes stay on this computer.`)
    return target
  } finally { await output.close().catch(() => {}); reader.releaseLock(); toast.dismiss(notice); await unlink(partial).catch(() => {}) }
}
export async function actOnThreadFile(id: string, file: string, action: 'open' | 'reveal') {
  try {
    let target = absoluteThreadFile(id, file)
    if (!threadFilesAreLocal(id)) {
      const key = `${machineOfThreadId(id)}:${id}:${file}`
      let request = pending.get(key)
      if (!request) { request = downloadFile(id, file); pending.set(key, request); void request.finally(() => pending.delete(key)).catch(() => {}) }
      target = await request
    }
    if (!target) throw Error('Open the conversation again, then retry.')
    if (action === 'open') await openTarget(target); else await revealPath(target)
  } catch (error) { toastProblem(error, { action: `${action} the file` }) }
}
