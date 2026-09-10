import { useStore } from "../src/state/store"
import type { Block } from "../src/state/transcript"
export const calls: { cursor: number; distance: number; duration?: number }[] = []
export const fixture = { all: [] as Block[], failNext: false }
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export async function loadEarlier(id: string) {
  const state = useStore.getState().transcripts[id]!
  const cursor = state.nextBeforeSeq!
  const record = { cursor, distance: document.querySelector<HTMLElement>('[data-chat-scroll-container]')!.scrollTop, duration: 0 }
  calls.push(record)
  const start = performance.now()
  useStore.getState().updateTranscript(id, current => ({ ...current, loadingEarlier: true }))
  await new Promise(resolve => setTimeout(resolve, 250))
  record.duration = performance.now() - start
  if (fixture.failNext) {
    fixture.failNext = false
    useStore.getState().updateTranscript(id, current => ({ ...current, loadingEarlier: false }))
    throw new Error("Connection interrupted. Try again.")
  }
  const index = fixture.all.findIndex(block => block.seq === cursor)
  const before = Math.max(0, index - 120)
  const older = fixture.all.slice(before, index)
  useStore.getState().updateTranscript(id, current => ({ ...current, blocks: [...older, ...current.blocks], nextBeforeSeq: before > 0 ? fixture.all[before]!.seq : null, loadingEarlier: false }))
}

export async function loadDiff() {}
export async function loadFileDiff() {}
export async function revertTo() {}
