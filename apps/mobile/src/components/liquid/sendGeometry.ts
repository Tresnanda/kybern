// One cubic Bézier for the spatial path, independent of the shared timing:
// a horizontal departure, a gradual upward turn, and continued travel on both
// axes into the endpoint. The final control stays away from target X so the
// bubble never parks at the right edge while the vertical leg catches up.
export function sendTravel(progress: number) {
  "worklet";
  const p = Math.max(0, Math.min(1, progress));
  const remaining = 1 - p;
  const first = 3 * remaining * remaining * p;
  const second = 3 * remaining * p * p;
  const end = p * p * p;
  return {
    x: first * 0.5 + second * 0.76 + end,
    y: second * 0.05 + end,
  };
}

export function sendProgress(
  elapsed: number,
  keyboardAtSend: number,
  keyboardNow: number,
) {
  "worklet";
  const timed = Math.max(0, Math.min(1, elapsed));
  const initialHeight = Math.abs(keyboardAtSend);
  if (initialHeight < 1) return timed;
  const dismissal = Math.max(
    0,
    Math.min(1, 1 - Math.abs(keyboardNow) / initialHeight),
  );
  // The flight starts with native keyboard movement, never after it. Do not
  // reach the bubble while the keyboard is still carrying that bubble down.
  return Math.min(timed, dismissal);
}

export function sendEndpointOffset(
  progress: number,
  keyboardAtSend: number,
  keyboardNow: number,
  destinationX: number,
  destinationY: number,
) {
  "worklet";
  const travel = sendTravel(progress);
  const sourceY = Math.abs(keyboardAtSend) - Math.abs(keyboardNow);
  // Move both ends of the curve with their layout. A fixed screen source and
  // descending destination bend an otherwise right-first curve the wrong way.
  return {
    x: destinationX * travel.x,
    y: sourceY * (1 - travel.y) + destinationY * travel.y,
  };
}
