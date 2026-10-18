/** Park after one publication. State folding and event observers remain ordered;
 * only external-store notifications for bursty text are joined at a frame. */
export function eventFrame(schedule: (flush: () => void) => () => void, notify: () => void) {
  let cancel: (() => void) | undefined
  const flush = () => {
    const stop = cancel
    cancel = undefined
    stop?.()
    notify()
  }
  return {
    next() { cancel ??= schedule(flush) },
    now: flush,
  }
}
