// Whether this build can embed a web page, decided once and read by every surface (`webHost.available`).
// Only macOS has the host today (`native/webview.m`, WKWebView). Windows and Linux get one with WP10; until then
// `webview.ts` never loads a library there and every surface shows its fallback (see `PORTING-PLATFORMS.md`, Web view).
// Kept free of `bun:ffi` so tests can load it anywhere and pass the platform and environment in.

export interface WebViewSupport {
  available: boolean
  /** Why not: `platform` (no host built for this OS yet) or `disabled` (`KYBERN_GPUIX_NO_WEBVIEW=1`, the test switch). */
  reason: 'platform' | 'disabled' | null
}

/** `KYBERN_GPUIX_NO_WEBVIEW=1` forces the capability off on any platform, so the fallbacks can be exercised on a Mac. */
export function webViewSupport(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): WebViewSupport {
  if (/^(1|true|yes|on)$/i.test(env.KYBERN_GPUIX_NO_WEBVIEW ?? '')) return { available: false, reason: 'disabled' }
  if (platform === 'darwin') return { available: true, reason: null }
  return { available: false, reason: 'platform' }
}

/** One sentence for the places that explain the missing web view. */
export const WEB_VIEW_MISSING = "Kybern can't embed web pages on this platform yet."
