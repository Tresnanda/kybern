// Shared macOS top-bar geometry. Kept here
// so the native traffic lights and the 46px web chrome stay on one centerline.
// Tauri's `trafficLightPosition` in `src-tauri/tauri.conf.json` must match
// `getMacTrafficLightPosition()` below.

export const CHAT_SURFACE_HEADER_HEIGHT_PX = 46

export const MAC_TRAFFIC_LIGHT_INSET_X_PX = 16

/** Vertically centers the native macOS traffic lights on the 46px toolbar, level
 * with the sidebar toggle + back/forward glyphs. Calibrated against the gap between
 * the dots and the icon centerline measured within a single window shot once the
 * inset is actually applied (crop-invariant): y=33 → dots ~8 CSS px low, y=43 → ~18
 * low, slope ~1 CSS px/unit, so the centered value is 25. macOS resets the buttons
 * to their default (high) after the window first paints, so `traffic_lights.rs`
 * re-applies this inset on show + resize/move/theme events. Must match
 * `trafficLightPosition.y` in `src-tauri/tauri.conf.json`. */
export const MAC_TRAFFIC_LIGHT_POSITION_Y_PX = 22

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
