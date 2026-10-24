// The app's one motion vocabulary, adapted from liquid-gooey
// (https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/liquid-gooey).
// Six words describe every surface that moves; each maps to a config below.
//
//   liquid    a surface changes shape: its centre (mass) leads, its size follows,
//             its corners settle on their own critically damped timeline.
//   weight    heavier surfaces travel slower and settle without wobble (MASS vs SIZE,
//             SHEET vs MENU). Nothing appears from nothing: start at 0.96, never 0.
//   momentum  a released finger hands its velocity to the spring (`withMomentum`).
//   recoil    arrival overshoots a little and comes back (dampingRatio 0.8), only
//             when a gesture or a mass carried energy in. Fades never recoil.
//   inertia   a flick travels on: project the release to decide where it lands
//             (`project`), so a short fast swipe still commits.
//   gooey     a trailing outline lags its content and stretches with the lag
//             (`gooeyLag`); the content itself never scales or rewraps.
//
// Reduce Motion: every spring here carries `ReduceMotion.System`, so it jumps to
// its end; components replace travel with a short fade (`FADE`). Native iOS
// components (menus, form sheets, alerts) keep their system motion.
import { Easing, ReduceMotion, cubicBezier } from "react-native-reanimated";

// liquid-gooey's morph defaults (EVOLVE_DEFAULTS), mapped through speed=2, bounce=.15.
// Separate springs preserve the mass-before-size character without a long wobble.
const SPEED = 2;
const DAMPING = (1 - 1.1 * 0.15) / 0.45;

/** Liquid: where a surface's centre goes. Leads. */
export const MASS = {
  stiffness: 320 * SPEED * SPEED,
  damping: 17 * SPEED * DAMPING,
  mass: 1,
  reduceMotion: ReduceMotion.System,
};
/** Liquid: how big the surface is. Follows the mass, with slight recoil. */
export const SIZE = {
  stiffness: 170 * SPEED * SPEED,
  damping: 11.5 * SPEED * DAMPING,
  mass: 1,
  reduceMotion: ReduceMotion.System,
};
// Menus morph with liquid-gooey's own character, not the near-critical UI springs
// above: speed 1.25, bounce 0.35 (ζ ≈ 0.62). The mass carries a little momentum and
// recoils; the size lags it and overshoots; the corners run their own timeline.
// liquid-gooey: stiffness × speed², damping × speed × ζ(bounce)/ζ(0.5).
const MENU_SPEED = 1.25;
const MENU_K = (1 - 1.1 * 0.35) / 0.45;
/** Menu morph: the centre (mass). Leads, with recoil. */
export const MENU_MASS = {
  stiffness: 320 * MENU_SPEED * MENU_SPEED,
  damping: 17 * MENU_SPEED * MENU_K,
  mass: 1,
  reduceMotion: ReduceMotion.System,
};
/** Menu morph: the size. Softer than the mass, so it follows and overshoots. */
export const MENU_SIZE = {
  stiffness: 170 * MENU_SPEED * MENU_SPEED,
  damping: 11.5 * MENU_SPEED * MENU_K,
  mass: 1,
  reduceMotion: ReduceMotion.System,
};
/** Menu morph: the corner timeline that starts every morph (droplet → corners). */
export const MENU_CORNER_MS = 460 / MENU_SPEED;
/** Menu morph: how long the droplet takes to round up (liquid-gooey's glide, dt × 8). */
export const MENU_DROPLET_MS = 120;
/** Menu morph: the mass's lead toward its destination (anticipation), progress/s. */
export const MENU_LEAD = 2.4;
/** Liquid: the corner timeline (liquid-gooey's cornerEase, 460 ms at speed 1). */
export const CORNER = {
  duration: 460 / SPEED,
  easing: Easing.bezier(0.3, 1.05, 0.4, 1),
  reduceMotion: ReduceMotion.System,
};

// Sheets travel much farther than a menu. The leading position settles first;
// the outline follows with a little recoil, without scaling its text.
export const SHEET = {
  duration: 500,
  dampingRatio: 0.8,
  reduceMotion: ReduceMotion.System,
};
export const SHEET_OUTLINE = {
  duration: 550,
  dampingRatio: 0.8,
  reduceMotion: ReduceMotion.System,
};
// Split-view panes (sidebar, inspector) that grow/shrink their column width.
// Snappier than a sheet and near-critically damped: a structural surface should
// arrive settled, not wobble. Interruptible — grab it mid-travel and it reverses.
export const PANE = {
  duration: 340,
  dampingRatio: 0.85,
  reduceMotion: ReduceMotion.System,
};
/** Recoil: a dragged thing snapping home or to a detent (pass the release velocity). */
export const RECOIL = {
  duration: 400,
  dampingRatio: 0.8,
  reduceMotion: ReduceMotion.System,
};
/** A finger-driven commit (swipe action, toast fling) that must not pass its edge. */
export const COMMIT = {
  duration: 300,
  dampingRatio: 0.8,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
};
/** Gooey: liquid-gooey's MOVE spring, for an outline trailing its content. */
export const TRAIL = {
  stiffness: 380,
  damping: 18,
  mass: 1,
  reduceMotion: ReduceMotion.System,
};

/** Strong ease-out for entrances and state changes without a finger. */
export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** EASE_OUT for Reanimated CSS transitions (`transitionTimingFunction`). */
export const CSS_EASE_OUT = cubicBezier(0.23, 1, 0.32, 1);
/** On-screen movement and in-place morphs (a submenu replacing its parent). */
export const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);

/** Durations (ms). Press feedback is under 150; nothing without a finger runs past 300. */
export const DURATION = {
  /** Row highlight in / out, button press scale. */
  pressIn: 80,
  pressOut: 200,
  press: 120,
  /** Small state change: chip, toggle, chevron rotation. */
  state: 180,
  /** Fades: enter / exit (exit is always shorter). */
  enter: 200,
  exit: 150,
  /** Scrim fade under menus and sheets. */
  scrim: 140,
} as const;
/** Reduce Motion replacement for travel: a short cross-fade. */
export const FADE = {
  duration: DURATION.enter,
  easing: EASE_OUT,
  reduceMotion: ReduceMotion.Never,
};

/** Momentum: a spring config that starts at the finger's release velocity. */
export function withMomentum<T extends object>(config: T, velocity: number) {
  "worklet";
  return { ...config, velocity };
}
/**
 * Inertia: where a released flick would come to rest (UIScrollView's normal
 * deceleration). Compare this, not the finger position, against a threshold.
 */
export function project(position: number, velocity: number, rate = 0.998) {
  "worklet";
  return position + ((velocity / 1000) * rate) / (1 - rate);
}
/** Rubber-band resistance past an edge, so a boundary gives instead of walling. */
export function rubberBand(overshoot: number, dimension: number, c = 0.55) {
  "worklet";
  const sign = Math.sign(overshoot);
  const x = Math.abs(overshoot);
  return sign * (1 - 1 / ((x * c) / dimension + 1)) * dimension;
}
/** Gooey: how far an outline lags its content, clamped so it never tears. */
export function gooeyLag(outline: number, content: number, max = 28) {
  "worklet";
  return Math.max(-max, Math.min(max, (outline - content) * 0.2));
}
