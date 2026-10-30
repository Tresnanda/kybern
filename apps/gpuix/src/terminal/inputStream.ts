// One ordered stream of keystrokes per terminal. A call per keystroke let two `terminals.input` requests pass each other
// (characters arrived reordered) and a paste or IME burst hit the daemon's concurrency limit. Bytes queue here; one write is in
// flight at a time, and everything that arrived meanwhile goes out as the next single frame.

/** The most bytes one write carries; a larger paste goes out as several writes in order. */
export const MAX_INPUT_FRAME = 32 * 1024

export interface InputStream {
  /** Queue bytes behind everything already sent. */
  push(bytes: Uint8Array): void
  /** Stop sending; queued bytes are dropped. */
  close(): void
}

export function createInputStream(write: (base64: string) => Promise<unknown>, onError: (error: unknown) => void): InputStream {
  let queued: Buffer[] = []
  let sending = false
  let closed = false
  const drain = async () => {
    if (sending) return
    sending = true
    try {
      while (queued.length && !closed) {
        const frame = Buffer.concat(queued)
        queued = []
        for (let at = 0; at < frame.length && !closed; at += MAX_INPUT_FRAME) await write(frame.subarray(at, at + MAX_INPUT_FRAME).toString('base64'))
      }
    } catch (error) {
      // Later bytes would arrive without the ones that failed: drop them and tell the reader.
      queued = []
      if (!closed) onError(error)
    } finally { sending = false }
  }
  return {
    push: (bytes) => { if (closed || !bytes.length) return; queued.push(Buffer.from(bytes)); void drain() },
    close: () => { closed = true; queued = [] },
  }
}
