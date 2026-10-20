import type { ThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ThreadsGetResult } from '../../../../packages/kybern-client/src/types.ts'

export const HISTORY_PREFETCH_BYTES = 1024 * 1024

/** One unmounted older page per open session. A live event invalidates the
 * snapshot, so consuming it uses the normal demand-load replay barrier. */
export class HistoryPrefetch {
  private page?: { cursor: number; through: number; ready: Promise<ThreadsGetResult | null> }

  prime(base: ThreadState, load: (cursor: number, through: number) => Promise<ThreadsGetResult>) {
    const cursor = base.nextBeforeSeq
    if (!base.loaded || cursor == null || base.loadingEarlier) return
    if (this.page?.cursor === cursor && this.page.through === base.lastSeq) return
    this.page = {
      cursor, through: base.lastSeq,
      ready: load(cursor, base.lastSeq).then(page => Buffer.byteLength(JSON.stringify(page), 'utf8') <= HISTORY_PREFETCH_BYTES ? page : null).catch(() => null),
    }
  }

  take(base: ThreadState): Promise<ThreadsGetResult | null> | undefined {
    const page = this.page
    this.clear()
    return page && page.cursor === base.nextBeforeSeq && page.through === base.lastSeq ? page.ready : undefined
  }

  clear() { this.page = undefined }
}
