/** Scene-local Metal backdrop. Logical pixels; blur is clamped to 0…64,
 * saturation to 0…3. Radius clips the filtered region, independently of layout.
 * On anchored, put this prop on the anchored element itself: its filter paints
 * inside the deferred layer and suppresses the legacy opaque default backing.
 * An explicit {blur:0} also opts into a transparent anchored backing.
 */
export interface BackdropFilter {
  blur?: number
  saturation?: number
  radius?: number
  /** Fraction of height over which the filter fades in from the top (0…1). */
  fadeTop?: number
}
declare module '@gpuix/native/host' {
  interface HostProps { backdrop?: BackdropFilter }
}

export const BACKDROP = {
  popup: {blur:40,saturation:1.5,radius:16},
  glass: {blur:16,saturation:1.25,radius:16},
  drop: {blur:18,saturation:1.25,radius:10},
  dropLabel: {blur:18,saturation:1.4,radius:8},
  liveScrim: {blur:10,saturation:1,radius:16,fadeTop:0.5},
  liveControls: {blur:12,saturation:1,radius:999},
  previewHeader: {blur:12,saturation:1.4,radius:0},
} satisfies Record<string,BackdropFilter>
