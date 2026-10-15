import type { ComputerFrame, ComputerFrameParams, ComputerFrameResult } from '../../../../packages/kybern-client/src/types.ts'
/** One outstanding request, no timer while hidden; late responses cannot revive a closed view. */
export class FramePoller {
  private timer?: ReturnType<typeof setTimeout>
  private generation = 0
  private busy = false
  private visible = false
  private stopped = false
  private after: number | null = null
  constructor(private threadId: string, private request: (p: ComputerFrameParams) => Promise<ComputerFrameResult>, private accept: (frame: ComputerFrame) => void, private startedAt = Date.now(), private interval = 700) {}
  show(visible: boolean) {
    if (this.stopped || visible === this.visible) return
    this.visible = visible; this.generation++; clearTimeout(this.timer)
    if (visible) void this.tick()
  }
  stop() { this.stopped = true; this.visible = false; this.generation++; clearTimeout(this.timer) }
  private async tick() {
    if (!this.visible || this.stopped || this.busy) return
    const generation = this.generation
    this.busy = true
    try {
      const { frame } = await this.request({ thread_id: this.threadId, after: this.after })
      if (frame && generation === this.generation && this.visible && !this.stopped) {
        this.after = frame.seq
        if (Date.parse(frame.captured_at) >= this.startedAt - 5000) this.accept(frame)
      }
    } catch { /* Reconnect on the next visible tick. */ }
    finally {
      this.busy = false
      if (this.visible && !this.stopped) this.timer = setTimeout(() => void this.tick(), this.interval)
    }
  }
}
