// Whether this build can embed a web page, decided once and read by every surface (`webHost.available`).
// macOS has the host in `native/webview.m` (WKWebView); Windows in `native/webview-win` (WebView2, WP10), when the
// Microsoft Edge WebView2 Runtime is installed; Linux in `native/webview-linux.c` (WPE WebKit drawn by GPUIX's
// `<websurface>`, WP10) when the companion was built or packaged and WebKit's web-process sandbox can run. Otherwise
// `webview.ts` never keeps a library loaded and every surface shows its fallback (see `PORTING-PLATFORMS.md`, Web view).
// Kept free of `bun:ffi` so tests can load it anywhere and pass the platform, environment and host probes in.

export type WebViewUnavailable = 'platform' | 'disabled' | 'runtime' | 'missing' | 'sandbox'

export interface WebViewSupport {
  available: boolean
  /**
   * Why not: `platform` (no host built for this OS yet), `disabled` (`KYBERN_GPUIX_NO_WEBVIEW=1`, the test switch),
   * `runtime` (Windows without the WebView2 Runtime), `missing` (the Windows host library is not beside the app) or
   * `sandbox` (Linux: pages would run outside WebKit's sandbox, so they open in the browser instead).
   */
  reason: WebViewUnavailable | null
  /** Linux `sandbox`: the companion's own sentence (what to install, or why this system refuses). */
  message?: string
}

/** What the Windows host library reports about itself: loaded and a runtime found, no runtime, or no library. */
export type WindowsHostState = 'ready' | 'runtime' | 'missing'

/** Linux only: whether `libkybern-webview.so` exists, and its sandbox verdict (null when pages can be sandboxed). */
export type LinuxWebViewProbe = () => { loaded: false } | { loaded: true; unavailable: string | null }

/** `KYBERN_GPUIX_NO_WEBVIEW=1` forces the capability off on any platform, so the fallbacks can be exercised on a Mac. */
export function webViewSupport(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env, windowsHost?: () => WindowsHostState, linux?: LinuxWebViewProbe): WebViewSupport {
  if (/^(1|true|yes|on)$/i.test(env.KYBERN_GPUIX_NO_WEBVIEW ?? '')) return { available: false, reason: 'disabled' }
  if (platform === 'darwin') return { available: true, reason: null }
  if (platform === 'win32' && windowsHost) {
    const state = windowsHost()
    return state === 'ready' ? { available: true, reason: null } : { available: false, reason: state }
  }
  if (platform === 'linux' && linux) {
    const probe = linux()
    if (!probe.loaded) return { available: false, reason: 'platform' }
    return probe.unavailable ? { available: false, reason: 'sandbox', message: probe.unavailable } : { available: true, reason: null }
  }
  return { available: false, reason: 'platform' }
}

/** One sentence for the places that explain the missing web view, for each reason. */
export function webViewMissingText(reason: WebViewUnavailable | null): string {
  if (reason === 'runtime') return 'Install the Microsoft Edge WebView2 Runtime (go.microsoft.com/fwlink/p/?LinkId=2124703), then reopen Kybern to see pages here.'
  if (reason === 'missing') return "This Kybern install is missing its web view. Reinstall Kybern to see pages here."
  if (reason === 'sandbox') return "This system does not let Kybern sandbox web pages, so pages open in your browser."
  return "Kybern can't embed web pages on this platform yet."
}

/** The sentence for this run: `webview.ts` sets it once it knows the reason (an ES live binding, read at call time). */
export let WEB_VIEW_MISSING = webViewMissingText('platform')
export function noteWebViewUnavailable(reason: WebViewUnavailable | null, message?: string) { WEB_VIEW_MISSING = message ?? webViewMissingText(reason) }
