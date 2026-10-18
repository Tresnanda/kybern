import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { useEffect, useState } from 'react'
import type { PublicInstance } from '@gpuix/react'
import { SidebarWindow, useSidebarRowLease, type SidebarWindowEntry } from './Window.tsx'

const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)

test('sidebar bounds follow jumps with bounded bodies, sparse slots and overlay/editor leases', async () => {
  let anchor = [0, 0, 700], token = 0
  const observers = new Map<number, (error: null, event: unknown) => void>()
  const hosts = new Set<number>(), children = new Map<number, Set<number>>(), parents = new Map<number, number>()
  const mounted = new Set<number>(), open = new Map<number, (value: boolean) => void>(), firstMounts = new Map<number, boolean>()
  const renderer = {
    applyBatch(json: string) {
      const destroyed: number[] = []
      const drop = (id: number) => { for (const child of children.get(id) ?? []) drop(child); children.delete(id); hosts.delete(id); destroyed.push(id) }
      for (const [op, id, value] of JSON.parse(json)) {
        if (op === 'createElement') hosts.add(id)
        if (op === 'destroyElement') drop(id)
        if (op === 'appendChild' || op === 'insertBefore') { children.get(parents.get(value)!)?.delete(value); parents.set(value, id); if (!children.has(id)) children.set(id, new Set()); children.get(id)!.add(value) }
      }
      return destroyed
    },
    setWindowKeyEvents() {}, setWindowSelectionChange() {}, getListScrollTop() { return anchor },
    addLayoutObserver(_target: unknown, callback: (error: null, event: unknown) => void) { observers.set(++token, callback); return token },
    removeLayoutObserver(id: number) { observers.delete(id) }, isLayoutObserverActive(id: number) { return observers.has(id) },
  }
  function Body({ index, first }: { index: number; first: boolean }) {
    const [held, setHeld] = useState(false)
    useSidebarRowLease(held)
    useEffect(() => { mounted.add(index); open.set(index, setHeld); firstMounts.set(index, first); return () => { mounted.delete(index); open.delete(index) } }, [index, first])
    return <text>{`Body ${index}`}</text>
  }
  let entries: SidebarWindowEntry[] = Array.from({ length: 3000 }, (_, index) => ({ key: String(index), height: index % 16 === 0 ? 40 : 30, render: (first: boolean) => <Body index={index} first={first} /> }))
  function List() {
    const [list, setList] = useState<PublicInstance | null>(null)
    return <SidebarWindow entries={entries} list={list} box={null} setList={setList} />
  }
  const root = createRoot(renderer)
  const settle = async () => { await Bun.sleep(1); flushSync(() => {}); await Bun.sleep(1) }
  const move = async (index: number, frame: number) => {
    anchor = [index, 12, 700]
    const callback = [...observers.values()][0]!
    expect(callback).toBeDefined()
    flushSync(() => callback(null, { elementId: 1, rect: null, frame }))
    await settle()
  }
  try {
    flushSync(() => root.render(<List />)); await settle()
    expect(mounted.size).toBeLessThan(90); expect(firstMounts.get(0)).toBe(true)
    expect(hosts.size).toBeLessThan(220)
    // Completion/disclosure owners mount outside the viewport until their
    // lifecycle removes the entry; normal rows remain bounded.
    entries = entries.map((entry,index) => index === 2500 ? {...entry,pinned:true} : entry)
    flushSync(() => root.render(<List />)); await settle()
    expect(mounted.has(2500)).toBe(true)
    entries = entries.map((entry,index) => index === 2500 ? {...entry,pinned:false} : entry)
    flushSync(() => root.render(<List />)); await settle()
    expect(mounted.has(2500)).toBe(false)
    flushSync(() => open.get(0)!(true)); await settle()
    await move(1000, 10)
    expect(mounted.has(1000)).toBe(true); expect(mounted.has(0)).toBe(true)
    flushSync(() => open.get(0)!(false)); await settle()
    expect(mounted.has(0)).toBe(false)
    // Cached replay can deliver older frame numbers after newer ones.
    await move(1500, 9); expect(mounted.has(1000)).toBe(true); expect(mounted.has(1500)).toBe(false)
    await move(2000, 11); expect(mounted.has(2000)).toBe(true); expect(mounted.has(1000)).toBe(false)
    await move(0, 12); expect(mounted.has(0)).toBe(true); expect(firstMounts.get(0)).toBe(false)
    expect(mounted.size).toBeLessThan(140); expect(observers.size).toBeLessThan(140)
    expect(hosts.size).toBeLessThan(300)
  } finally { root.unmount() }
  expect(observers.size).toBe(0); expect(mounted.size).toBe(0); expect(hosts.size).toBe(0)
})
