// Shared macOS top-bar geometry. Kept here
// so the native traffic lights and the 46px web chrome stay on one centerline.
// Tauri's `trafficLightPosition` in `src-tauri/tauri.conf.json` must match
// `getMacTrafficLightPosition()` below.

export const CHAT_SURFACE_HEADER_HEIGHT_PX = 46

export const MAC_TRAFFIC_LIGHT_INSET_X_PX = 16

/** Tauri's `trafficLightPosition.y`: it grows the native title-bar container to
 * the 14px button height plus this, so 32 makes the container the full 46px web
 * title bar. `traffic_lights.rs` then centers the dots on that bar's midline
 * explicitly (macOS leaves them 9px off the container's bottom, which put them
 * 4px above the toolbar icons). Must match `trafficLightPosition.y` in
 * `src-tauri/tauri.conf.json`. */
export const MAC_TRAFFIC_LIGHT_POSITION_Y_PX = 32

/** Radius of a macOS traffic-light dot (~14px across). */
export const MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX = 7

/** Leading inset from the window edge to the sidebar-toggle cluster. Measured on
 * macOS 26: the traffic lights center at x=23/46/69, so a 28px control starting at
 * 82 centers at 96, a 27px step from the last light, matching Codex. */
export const MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX = 82

export function getMacTrafficLightPosition(): { x: number; y: number } {
  return {
    x: MAC_TRAFFIC_LIGHT_INSET_X_PX,
    y: MAC_TRAFFIC_LIGHT_POSITION_Y_PX,
  }
}
