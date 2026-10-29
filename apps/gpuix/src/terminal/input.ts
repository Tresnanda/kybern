/**
 * Keys to the pty in the order they were typed. The daemon runs each request as its own task, and a connection has 16 request
 * slots shared with everything else the app loads: one `terminals.input` call per key arrived shuffled, or was refused under load
 * ("Too many concurrent requests"), and the keystroke was lost. One call is in flight; input written meanwhile goes in the next.
 */
export function inputQueue(write: (data: Buffer) => Promise<unknown>, fail: (error: unknown) => void) {
  let pending: Buffer[] = [], busy = false
  const flush = () => {
    if (busy || !pending.length) return
    const data = Buffer.concat(pending)
    pending = []; busy = true
    void write(data).catch(fail).finally(() => { busy = false; flush() })
  }
  return (data: Buffer) => { if (data.length) { pending.push(data); flush() } }
}
