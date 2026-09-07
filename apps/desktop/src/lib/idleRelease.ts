/** One timer per expensive resource, never one per frame or message. */
export function createIdleRelease(isIdle: () => boolean, release: () => void, delay = 30_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const touch = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  return {
    touch,
    settle() {
      touch()
      if (isIdle()) timer = setTimeout(() => { timer = undefined; if (isIdle()) release() }, delay)
    },
    dispose: touch,
  }
}
