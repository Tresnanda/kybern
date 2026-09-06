// Terminal workspace for a thread: a tab
// strip of terminals (shells and agent CLIs) with identity icons, new-tab and
// close actions, and one xterm + pty per tab that stays alive across tab
// switches. Terminals render edge to edge on the surface colour.

import { observeResizeFrame } from "@/lib/resizeObserver"
import "@xterm/xterm/css/xterm.css"

import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ProviderMark, Spinner } from "@/components/kybern/bits"
import { useTheme } from "@/components/theme-context"
import { IconButton } from "@/components/kit/icon-button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from "@/components/kit/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { PROVIDER_LABEL } from "@/lib/format"
import { CentralIcon } from "@/lib/kit/central-icons"
import { Plus, TerminalSquareIcon, Trash2 } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ProviderKind, TerminalExitedNotification, TerminalId, TerminalOutputNotification, ThreadId } from "@/protocol"
import { TERMINAL_EXITED_NOTIFICATION, TERMINAL_OUTPUT_NOTIFICATION } from "@/protocol"
import { errorText, rpc } from "@/state/rpc"
import { useStore, type TerminalTab } from "@/state/store"

import { CHAT_SURFACE_CHIP_CLASS_NAME, DOCK_HEADER_ICON_BUTTON_CLASS } from "./chrome"

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const bytesToB64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

const EMPTY: never[] = []
const TAB_CHIP = `${CHAT_SURFACE_CHIP_CLASS_NAME} group/dock-tab inline-flex min-w-0 items-center pr-2.5`
const TAB_ACTIVE = "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]"

// Terminal palette; the background follows the app surface.
const DARK = {
  foreground: "rgb(237,241,247)",
  cursor: "rgb(180,203,255)",
  selectionBackground: "rgba(180,203,255,0.25)",
  black: "rgb(24,30,38)",
  red: "rgb(255,122,142)",
  green: "rgb(134,231,149)",
  yellow: "rgb(244,205,114)",
  blue: "rgb(137,190,255)",
  magenta: "rgb(208,176,255)",
  cyan: "rgb(124,232,237)",
  white: "rgb(210,218,230)",
  brightBlack: "rgb(110,120,136)",
}
const LIGHT = {
  foreground: "rgb(28,33,41)",
  cursor: "rgb(38,56,78)",
  selectionBackground: "rgba(37,63,99,0.2)",
  black: "rgb(44,53,66)",
  red: "rgb(191,70,87)",
  green: "rgb(60,126,86)",
  yellow: "rgb(146,112,35)",
  blue: "rgb(72,102,163)",
  magenta: "rgb(132,86,149)",
  cyan: "rgb(53,127,141)",
  white: "rgb(210,215,223)",
  brightBlack: "rgb(112,123,140)",
}

function surfaceColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--color-background-surface").trim()
  return v || "#181818"
}

function xtermTheme(dark: boolean) {
  const glass = getComputedStyle(document.documentElement).getPropertyValue("--app-full-translucency").trim() === "1"
  const bg = glass ? "#00000000" : surfaceColor()
  return { ...(dark ? DARK : LIGHT), background: bg, cursorAccent: glass ? (dark ? "#181818" : "#ffffff") : bg }
}

function useIsDark(): boolean {
  const { theme } = useTheme()
  return theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
}

/** Agent CLIs that can be opened as a terminal tab: the installed providers' binaries. */
function useAgentClis() {
  const providers = useStore((s) => s.providers)
  return useMemo(
    () =>
      providers
        .filter((p) => p.available && p.binary_path)
        .map((p) => ({ kind: p.kind as ProviderKind, label: p.display_name, command: [p.binary_path!] })),
    [providers],
  )
}

export function TerminalWorkspace({ threadId, active }: { threadId: ThreadId; active: boolean }) {
  const tabs = useStore((s) => s.terminalTabs[threadId] ?? EMPTY)
  const activeKey = useStore((s) => s.activeTerminalTab[threadId] ?? null)
  const set = useStore((s) => s.set)
  const clis = useAgentClis()

  const setTabs = useCallback(
    (f: (tabs: TerminalTab[]) => TerminalTab[], nextActive?: string | null) =>
      set((s) => {
        const next = f(s.terminalTabs[threadId] ?? [])
        const current = s.activeTerminalTab[threadId] ?? null
        const active = nextActive !== undefined ? nextActive : next.some((t) => t.key === current) ? current : (next[next.length - 1]?.key ?? null)
        return { terminalTabs: { ...s.terminalTabs, [threadId]: next }, activeTerminalTab: { ...s.activeTerminalTab, [threadId]: active } }
      }),
    [set, threadId],
  )

  const addTab = useCallback(
    (kind: TerminalTab["kind"], command?: string[]) => {
      const key = crypto.randomUUID()
      setTabs((tabs) => {
        const n = tabs.filter((t) => t.kind === kind).length + 1
        const title = kind === "shell" ? (n === 1 ? "Terminal" : `Terminal ${n}`) : `${PROVIDER_LABEL[kind] ?? kind} ${n}`
        return [...tabs, { key, title, kind, command }]
      }, key)
    },
    [setTabs],
  )

  const closeTab = useCallback((key: string) => {
    const tab = useStore.getState().terminalTabs[threadId]?.find((item) => item.key === key)
    if (tab?.terminalId) void rpc().call("terminals.close", { terminal_id: tab.terminalId }).catch(() => {})
    setTabs((tabs) => tabs.filter((t) => t.key !== key))
  }, [setTabs, threadId])
  const retitle = useCallback((key: string, title: string) => setTabs((tabs) => tabs.map((t) => (t.key === key && t.kind === "shell" ? { ...t, title } : t))), [setTabs])

  // The pane always shows a live terminal: open a shell the first time it is used.
  useEffect(() => {
    if (active && tabs.length === 0) addTab("shell")
  }, [active, tabs.length, addTab])

  const current = tabs.find((t) => t.key === activeKey) ?? tabs[0] ?? null

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)]">
      <div className="flex min-h-9 items-center gap-1 bg-[var(--color-background-surface)] px-1.5 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((t) => (
            <TabChip key={t.key} tab={t} active={t.key === current?.key} onSelect={() => setTabs((x) => x, t.key)} onClose={() => closeTab(t.key)} />
          ))}
          <Tooltip>
            <TooltipTrigger render={<IconButton variant="chrome" size="icon-xs" className={DOCK_HEADER_ICON_BUTTON_CLASS} label="New terminal tab" onClick={() => addTab("shell")} />}>
              <Plus className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">New terminal</TooltipPopup>
          </Tooltip>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Menu>
            <IconButton render={<MenuTrigger />} variant="chrome" size="icon-xs" className={DOCK_HEADER_ICON_BUTTON_CLASS} label="Open an agent CLI" tooltip="Open an agent CLI" tooltipSide="bottom">
              <TerminalSquareIcon className="size-3.5" />
            </IconButton>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-52 min-w-52">
              <MenuGroup>
                <MenuGroupLabel>Open in a new tab</MenuGroupLabel>
                <MenuItem onClick={() => addTab("shell")}>
                  <CentralIcon name="console" className="size-3.5 shrink-0" /> Shell
                </MenuItem>
              </MenuGroup>
              {clis.length > 0 && (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Agent CLIs in this environment</MenuGroupLabel>
                    {clis.map((c) => (
                      <MenuItem key={c.kind} onClick={() => addTab(c.kind, c.command)}>
                        <ProviderMark kind={c.kind} size={14} className="size-3.5 shrink-0 opacity-100" /> {c.label}
                      </MenuItem>
                    ))}
                  </MenuGroup>
                </>
              )}
            </ComposerPickerMenuPopup>
          </Menu>
          <Tooltip>
            <TooltipTrigger
              render={<IconButton variant="chrome" size="icon-xs" className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, !current && "pointer-events-none opacity-45")} label="Close active terminal tab" onClick={() => current && closeTab(current.key)} />}
            >
              <Trash2 className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Close terminal</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      <div className="relative min-h-0 min-w-0 flex-1 bg-[var(--color-background-surface)]">
        {tabs.map((t) => {
          const isActive = active && t.key === current?.key
          return (
            <div key={t.key} className={cn("absolute inset-0 min-h-0 min-w-0 transition-opacity", isActive ? "z-[1] opacity-100" : "pointer-events-none z-0 opacity-0")}>
              <TerminalInstance threadId={threadId} tab={t} active={isActive} onExit={() => closeTab(t.key)} onTitle={(title) => retitle(t.key, title)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TabChip({ tab, active, onSelect, onClose }: { tab: TerminalTab; active: boolean; onSelect: () => void; onClose: () => void }) {
  return (
    <button type="button" onClick={onSelect} title={tab.title} data-pressed={active || undefined} className={cn(TAB_CHIP, active && TAB_ACTIVE)}>
      <span
        role="button"
        aria-label={`Close ${tab.title}`}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full bg-transparent text-[var(--color-text-foreground-secondary)] transition-colors group-hover/dock-tab:bg-[var(--color-background-button-secondary-hover)] hover:bg-[var(--color-background-button-secondary)] hover:text-[var(--color-text-foreground)]"
      >
        <span className="transition-opacity group-hover/dock-tab:opacity-0">
          {tab.kind === "shell" ? <TerminalSquareIcon className="size-3.5 text-[var(--color-text-foreground)]" /> : <ProviderMark kind={tab.kind} size={14} className="size-3.5" />}
        </span>
        <CentralIcon name="cross-small" className="absolute size-3.5 shrink-0 opacity-0 transition-opacity group-hover/dock-tab:opacity-100" />
      </span>
      <span className="max-w-40 truncate">{tab.title}</span>
    </button>
  )
}

/** One xterm bound to one daemon pty. Created on first show, kept alive while its tab exists. */
function TerminalInstance({ threadId, tab, active, onExit, onTitle }: { threadId: ThreadId; tab: TerminalTab; active: boolean; onExit: () => void; onTitle: (t: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [everActive, setEverActive] = useState(active)
  const dark = useIsDark()
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<TerminalId | null>(null)
  const cwd = useStore((s) => s.threads[threadId]?.cwd)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle

  useEffect(() => {
    if (active) setEverActive(true)
  }, [active])

  useEffect(() => {
    const update = () => { if (termRef.current) termRef.current.options.theme = xtermTheme(dark) }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-full-translucency", "data-window-material", "style"] })
    const preferences = [matchMedia("(prefers-reduced-transparency: reduce)"), matchMedia("(prefers-contrast: more)")]
    for (const preference of preferences) preference.addEventListener("change", update)
    return () => {
      observer.disconnect()
      for (const preference of preferences) preference.removeEventListener("change", update)
    }
  }, [dark])

  // Coming back on screen: fit to the real box, repaint, tell the pty, focus.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!active || !term || !fit) return
    const raf = requestAnimationFrame(() => {
      fit.fit()
      term.refresh(0, Math.max(0, term.rows - 1))
      if (idRef.current) rpc().call("terminals.resize", { terminal_id: idRef.current, cols: term.cols, rows: term.rows }).catch(() => {})
      term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, ready])

  useEffect(() => {
    const el = host.current
    if (!el || !cwd || !everActive) return
    let disposed = false
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 12,
      fontWeight: 300,
      fontWeightBold: 500,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      allowTransparency: true,
      customGlyphs: true,
      theme: xtermTheme(dark),
      scrollback: 5000,
    })
    termRef.current = term
    // App shortcuts (Cmd+K, Cmd+B, ...) win over the shell.
    term.attachCustomKeyEventHandler((e) => !(e.metaKey && !e.ctrlKey && !e.altKey))
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    import("@xterm/addon-webgl")
      .then((m) => {
        if (disposed) return
        const webgl = new m.WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
          term.refresh(0, Math.max(0, term.rows - 1))
        })
        term.loadAddon(webgl)
        term.refresh(0, Math.max(0, term.rows - 1))
      })
      .catch(() => {})

    const client = rpc()
    const ownerStore = useStore
    let attaching = false
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const offOut = client.onNotification(TERMINAL_OUTPUT_NOTIFICATION, (p) => {
      const n = p as TerminalOutputNotification
      if (n.terminal_id === idRef.current) term.write(b64ToBytes(n.data))
    })
    const offExit = client.onNotification(TERMINAL_EXITED_NOTIFICATION, (p) => {
      const n = p as TerminalExitedNotification
      if (n.terminal_id !== idRef.current) return
      term.write(`\r\n\x1b[2m[process exited${n.exit_code != null ? ` with ${n.exit_code}` : ""}]\x1b[0m\r\n`)
      idRef.current = null
      // A tab whose program ended closes itself.
      exitTimer = setTimeout(() => { if (!disposed) onExitRef.current() }, 600)
    })
    const titleSub = term.onTitleChange((raw) => {
      // Shells announce "user@host:/full/path"; the tab only needs the folder name.
      const t = raw.trim()
      if (!t) return
      const m = /^[^@\s]+@[^:]+:(.+)$/.exec(t)
      const path = m?.[1] ?? t
      const name = path.replace(/\/+$/, "").split("/").pop() || path
      onTitleRef.current(name.length > 32 ? `${name.slice(0, 31)}…` : name)
    })

    const attach = async () => {
      if (disposed || attaching || client.status !== "open") return
      const startedAt = ownerStore.getState().info?.started_at
      const saved = ownerStore.getState().terminalTabs[threadId]?.find((item) => item.key === tab.key)
      if (!saved) return
      if (saved.daemonStartedAt && saved.daemonStartedAt !== startedAt) {
        setError("The environment restarted. Open a new terminal tab to start a new process.")
        return
      }
      attaching = true
      setError(null)
      setReady(false)
      // Persist the request identity before sending. Retrying after a lost
      // acknowledgment attaches to the same PTY instead of launching twice.
      ownerStore.getState().set((state) => ({ terminalTabs: {
        ...state.terminalTabs,
        [threadId]: (state.terminalTabs[threadId] ?? []).map((item) => item.key === tab.key ? { ...item, terminalId: tab.key, daemonStartedAt: startedAt } : item),
      } }))
      try {
        const info = await client.call("terminals.create", { terminal_id: tab.key, thread_id: threadId, cwd, cols: term.cols, rows: term.rows, command: tab.command })
        if (disposed) {
          if (!ownerStore.getState().terminalTabs[threadId]?.some((item) => item.key === tab.key)) {
            void client.call("terminals.close", { terminal_id: info.id }).catch(() => {})
          }
          return
        }
        idRef.current = info.id
        term.reset()
        await client.call("terminals.subscribe", { terminal_id: info.id, replay: true })
        if (!disposed) { setReady(true); if (active) term.focus() }
      } catch (e) { if (!disposed) setError(errorText(e)) }
      finally { attaching = false }
    }
    const offStatus = client.onStatus((status) => {
      if (status === "open") void attach()
      else if (!disposed) setReady(false)
    })
    const offLag = client.onNotification("terminal.lagged", (params) => {
      if ((params as { terminal_id: string }).terminal_id === idRef.current) void attach()
    })
    void attach()

    const inputSub = term.onData((data) => {
      if (idRef.current) client.call("terminals.input", { terminal_id: idRef.current, data: bytesToB64(data) }).catch(() => {})
    })
    const stopResize = observeResizeFrame(el, () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      const { cols, rows } = term
      fit.fit()
      if (idRef.current && (term.cols !== cols || term.rows !== rows)) {
        client.call("terminals.resize", { terminal_id: idRef.current, cols: term.cols, rows: term.rows }).catch(() => {})
      }
    })

    return () => {
      disposed = true
      stopResize()
      inputSub.dispose()
      titleSub.dispose()
      offOut()
      offExit()
      offStatus()
      offLag()
      clearTimeout(exitTimer)
      if (idRef.current) client.call("terminals.unsubscribe", { terminal_id: idRef.current }).catch(() => {})
      idRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, cwd, everActive])

  return (
    <div className="h-full min-h-0 w-full bg-[var(--color-background-surface)] px-3 pt-1 pb-2" onClick={() => termRef.current?.focus()}>
      <div className="relative h-full min-h-0 w-full overflow-hidden">
        <div ref={host} className="xterm-host absolute inset-0" />
        {!ready && !error && everActive && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Spinner />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] text-muted-foreground text-balance">
            Unable to open a terminal. {error}
          </div>
        )}
      </div>
    </div>
  )
}
