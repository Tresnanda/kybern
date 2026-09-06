// These browser notifications defer a layout observation; they are not an
// exception thrown by application code. Leave them in the browser console.
export function isResizeObserverNotice(event: Pick<ErrorEvent, "message" | "error">): boolean {
  return event.error == null && (
    event.message === "ResizeObserver loop completed with undelivered notifications." ||
    event.message === "ResizeObserver loop limit exceeded"
  )
}

function errorDetails(reason: unknown, fallback: string): string {
  if (reason instanceof Error) {
    const summary = `${reason.name}: ${reason.message}`
    return reason.stack ? (reason.stack.includes(summary) ? reason.stack : `${summary}\n${reason.stack}`) : summary
  }
  return fallback
}

export function installRuntimeErrorReporting(target: Window, report: (details: string) => void): () => void {
  const onError = (event: ErrorEvent) => {
    if (isResizeObserverNotice(event)) return
    report(errorDetails(event.error, event.message || "An unexpected interface error occurred."))
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    report(errorDetails(event.reason, String(event.reason)))
  }
  target.addEventListener("error", onError)
  target.addEventListener("unhandledrejection", onRejection)
  return () => {
    target.removeEventListener("error", onError)
    target.removeEventListener("unhandledrejection", onRejection)
  }
}
