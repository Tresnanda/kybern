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
