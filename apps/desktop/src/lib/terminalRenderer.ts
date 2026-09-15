import type { Terminal } from "@xterm/xterm"
import type { WebglAddon } from "@xterm/addon-webgl"

/** Own only graphics resources. The terminal, PTY and scrollback outlive tabs. */
export function createTerminalRenderer(
  terminal: Terminal,
  load = () => import("@xterm/addon-webgl"),
) {
  let addon: WebglAddon | undefined
  let active = false
  let disposed = false
  let generation = 0
  const release = () => {
    ++generation
    const previous = addon
    addon = undefined
    previous?.dispose()
  }
  return {
    setActive(next: boolean) {
      if (disposed) return
      terminal.options.cursorBlink = next
      if (active === next) return
      active = next
      if (!next) { release(); return }
      const request = ++generation
      void load().then(({ WebglAddon }) => {
        if (disposed || !active || generation !== request) return
        const renderer = new WebglAddon()
        addon = renderer
        renderer.onContextLoss(() => {
          if (addon !== renderer) return
          release()
          terminal.refresh(0, Math.max(0, terminal.rows - 1))
        })
        try {
          terminal.loadAddon(renderer)
          terminal.refresh(0, Math.max(0, terminal.rows - 1))
        } catch { release() } // Keep xterm's DOM renderer when WebGL is unavailable.
      }).catch(() => {})
    },
    dispose() { disposed = true; release() },
  }
}
