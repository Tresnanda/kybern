/** Bound background metadata reads; new rows take precedence over queued old
 * rows. Pumping uses microtasks only and parks completely when work finishes. */
export class DeferredReads {
  private active = 0
  private scheduled = false
  private queued: (() => void)[] = []
  constructor(private readonly limit = 4) {}

  run<T>(read: () => Promise<T>): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.queued.push(() => {
        this.active++
        void Promise.resolve().then(read).then(resolve, reject).finally(() => {
          this.active--
          this.pump()
        })
      })
    })
    if (!this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => { this.scheduled = false; this.pump() })
    }
    return result
  }

  private pump() {
    while (this.active < this.limit && this.queued.length) this.queued.pop()!()
  }
}
