// The first paint after launch allocates the page's compositing buffers at
// once; entrance motion and spinners running during it add their own layers on
// top. In the native real-session fixture, turning them off took the boot peak
// from 252–279 to 183–208 MiB. Surfaces first mounted during launch appear
// settled; later mounts (project switches, sidebar surface swaps) animate.
const LAUNCH_MS = 1500

/** Read once at mount time. Never toggle an entrance class on a live element. */
export const isLaunching = (): boolean => performance.now() < LAUNCH_MS
