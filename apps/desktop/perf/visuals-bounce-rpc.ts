// Test-only transport: frame URLs come from the fixture runner's local server (daemon-equivalent
// documents, CSP and bootstrap), so no daemon or installed browser is needed.
declare const __VISUAL_BOUNCE__: { base: string }
let tickets = 0
export const transport = { mints: 0 }
export const activeRuntime = () => ({
  rpc: () => ({ call: async () => ({}) }),
  // Visual ids are `<run>-<page>`; the runner serves the page named by the last segment.
  visualFrameUrl: async (_threadId: string, visualId: string) => {
    transport.mints++
    const ticket = String(++tickets)
    return { url: `${__VISUAL_BOUNCE__.base}/visual-frame/${visualId.split("-").at(-1)}/${ticket}`, ticket }
  },
})
export const errorText = (error: unknown) => String(error)
export const openExternal = async () => {}
