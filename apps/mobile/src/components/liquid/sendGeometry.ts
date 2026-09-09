// All flying parts use the same right-first path, including displacement of
// the two endpoints. The source belongs to the moving composer, not the screen.
export function sendTravel(progress: number) {
  "worklet";
  const p = Math.max(0, Math.min(1, progress));
  return { x: 1 - (1 - p) ** 2, y: p ** 2 };
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
  // Keyboard Controller's height is negative above the bottom edge. Applying
  // only destination movement leaves the source hanging at the old keyboard.
  const sourceY = Math.abs(keyboardAtSend) - Math.abs(keyboardNow);
  return {
    x: destinationX * travel.x,
    y: sourceY * (1 - travel.y) + destinationY * travel.y,
  };
}
