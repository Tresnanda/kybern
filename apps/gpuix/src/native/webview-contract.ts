/** Proposed WKWebView ABI, NOT implemented or advertised as a capability. */
export interface EmbeddedWebViewRect {
  /** Logical pixels relative to the GPUI window content area, top-left origin. */
  x: number
  y: number
  width: number
  height: number
}
export interface EmbeddedWebViewOptions {
  /** Opaque per-document ID. Dock and mini-player move the same host. */
  id: string
  /** Already-authorized preview ticket/relay URL; never a daemon bearer token. */
  url: string
  /** Explicit origins allowed for top-level navigation. Redirects checked too. */
  allowedOrigins: string[]
  /** Separate nonpersistent WKWebsiteDataStore per environment. */
  environmentId: string
}
export type EmbeddedWebViewEvent =
  | { type: 'navigation'; id: string; generation: number; url: string; title: string; canGoBack: boolean; canGoForward: boolean }
  | { type: 'loading'; id: string; generation: number; loading: boolean; progress: number }
  | { type: 'failed'; id: string; generation: number; message: string }
  | { type: 'externalNavigation'; id: string; generation: number; url: string }
  | { type: 'focus'; id: string; focused: boolean }
  | { type: 'terminated'; id: string; generation: number }

/** Future native implementation must enforce the lifecycle in native/README.md. */
export interface EmbeddedWebViewHost {
  /** Creates hidden, idempotently rejects an existing ID. Maximum two hosts. */
  create(options: EmbeddedWebViewOptions): Promise<void>
  /** Atomically updates native view frame, clipping and visibility once per frame. */
  place(id: string, rect: EmbeddedWebViewRect, clip: EmbeddedWebViewRect, visible: boolean): void
  /** Generation increases on every navigation; stale callbacks are ignored. */
  navigate(id: string, url: string): Promise<number>
  command(id: string, command: 'back' | 'forward' | 'reload' | 'stop'): void
  focus(id: string): void
  /** Remove view/delegates/handlers and pending callbacks; repeat is harmless. */
  destroy(id: string): Promise<void>
  subscribe(listener: (event: EmbeddedWebViewEvent) => void): () => void
}
