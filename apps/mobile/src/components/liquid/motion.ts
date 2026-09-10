import { ReduceMotion } from "react-native-reanimated";
// liquid-gooey's morph defaults, mapped through speed=2, bounce=.15.
// Separate springs preserve the mass-before-size character without a long wobble.
const SPEED = 2;
const DAMPING = (1 - 1.1 * 0.15) / 0.45;
export const MASS = {
  stiffness: 320 * SPEED * SPEED,
  damping: 17 * SPEED * DAMPING,
  mass: 1,
  reduceMotion: ReduceMotion.System,
};
export const SIZE = {
  stiffness: 170 * SPEED * SPEED,
  damping: 11.5 * SPEED * DAMPING,
  mass: 1,
  reduceMotion: ReduceMotion.System,
};

// Sheets travel much farther than a menu. The leading position settles first;
// the outline follows with a little recoil, without scaling its text.
export const SHEET = {
  duration: 500,
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
export const SHEET_OUTLINE = {
  duration: 550,
  dampingRatio: 0.8,
  reduceMotion: ReduceMotion.System,
};
