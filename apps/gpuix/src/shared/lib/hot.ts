// Stateful modules (store, rpc, transcript, client) cannot be hot-swapped
// without dropping the live daemon connection, so they reload the page
// instead. Several of them usually change in one HMR batch; WKWebView left a
// blank document when `location.reload()` fired more than once in a row, so
// the reload is coalesced here.

declare global {
  interface Window {
    __kybernReloading?: boolean
  }
}

export function reloadOnHotUpdate(hot: ImportMeta["hot"]) {
  if (!hot) return
  hot.accept(() => {
    if (window.__kybernReloading) return
    window.__kybernReloading = true
    setTimeout(() => window.location.reload(), 80)
  })
}
