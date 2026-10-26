// Whether this build can embed a web page, decided once and read by every surface (`webHost.available`).
// macOS has the host in `native/webview.m` (WKWebView); Windows in `native/webview-win` (WebView2, WP10), when the
// Microsoft Edge WebView2 Runtime is installed. Linux gets one later; until then `webview.ts` never loads a library
// there and every surface shows its fallback (see `PORTING-PLATFORMS.md`, Web view).
// Kept free of `bun:ffi` so tests can load it anywhere and pass the platform, environment and Windows probe in.

export type WebViewUnavailable = 'platform' | 'disabled' | 'runtime' | 'missing'

export interface WebViewSupport {
  available: boolean
  /**
   * Why not: `platform` (no host built for this OS yet), `disabled` (`KYBERN_GPUIX_NO_WEBVIEW=1`, the test switch),
   * `runtime` (Windows without the WebView2 Runtime) or `missing` (the Windows host library is not beside the app).
   */
  reason: WebViewUnavailable | null
}

/** What the Windows host library reports about itself: loaded and a runtime found, no runtime, or no library. */
export type WindowsHostState = 'ready' | 'runtime' | 'missing'

/** `KYBERN_GPUIX_NO_WEBVIEW=1` forces the capability off on any platform, so the fallbacks can be exercised on a Mac. */
export function webViewSupport(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env, windowsHost?: () => WindowsHostState): WebViewSupport {
  if (/^(1|true|yes|on)$/i.test(env.KYBERN_GPUIX_NO_WEBVIEW ?? '')) return { available: false, reason: 'disabled' }
  if (platform === 'darwin') return { available: true, reason: null }
  if (platform === 'win32' && windowsHost) {
    const state = windowsHost()
    return state === 'ready' ? { available: true, reason: null } : { available: false, reason: state }
  }
  return { available: false, reason: 'platform' }
}

/** One sentence for the places that explain the missing web view, for each reason. */
export function webViewMissingText(reason: WebViewUnavailable | null): string {
  if (reason === 'runtime') return 'Install the Microsoft Edge WebView2 Runtime (go.microsoft.com/fwlink/p/?LinkId=2124703), then reopen Kybern to see pages here.'
  if (reason === 'missing') return "This Kybern install is missing its web view. Reinstall Kybern to see pages here."
  return "Kybern can't embed web pages on this platform yet."
}

/** The sentence for this run: `webview.ts` sets it once it knows the reason (an ES live binding, read at call time). */
export let WEB_VIEW_MISSING = webViewMissingText('platform')
export function noteWebViewUnavailable(reason: WebViewUnavailable | null) { WEB_VIEW_MISSING = webViewMissingText(reason) }
