/** Native spring transitions. Velocity applies to translation, in logical px/s.
 * Pass the last pointer sample velocity on release; omitted axes start at rest. */
export interface NativeSpringTransition {
  type: 'spring'
  duration?: number
  bounce?: number
  velocityX?: number
  velocityY?: number
  delay?: number
}
