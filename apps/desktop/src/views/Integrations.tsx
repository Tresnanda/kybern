import { useEffect, useState } from "react"
import { Button } from "@/components/kit/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/kit/input-group"
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@/components/kit/menu"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { ChevronDownIcon, ExternalLinkIcon, McpIcon, PluginIcon, RefreshCwIcon, SearchIcon } from "@/lib/kit/icons"
import { openExternal } from "@/lib/tauri"
import {
  SETTINGS_CARD_CLASS_NAME,
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "@/lib/kit/settingsPanelStyles"
import { cn } from "@/lib/utils"
import type {
  Integration,
  IntegrationAction,
  IntegrationsCatalog,
  ProviderKind,
} from "@/protocol"
import { activeRuntime, errorText } from "@/state/rpc"
import { useStore } from "@/state/store"

const labels: Record<IntegrationAction, string> = {
  install: "Install",
  uninstall: "Uninstall",
  enable: "Enable",
  disable: "Disable",
  update: "Update",
}
const CONNECTORS_URL = "https://claude.ai/settings/connectors"
export function Integrations() {
  const projects = useStore((s) => s.projects)
  const selected = useStore((s) => s.selected)
  const thread = useStore((s) =>
    selected.kind === "thread" ? s.threads[selected.id] : undefined
  )
  const connected = useStore((s) => s.connection.state === "open")
  const [projectId, setProjectId] = useState(
    thread?.project_id ??
      (selected.kind === "draft"
        ? selected.draft.projectId
        : Object.keys(projects)[0]) ??
      ""
  )
  const [provider, setProvider] = useState<ProviderKind>(
    thread?.provider.kind === "codex" ? "codex" : "claude-code"
  )
  const [category, setCategory] = useState<"plugin" | "connector">("plugin")
  const [query, setQuery] = useState("")
  const [catalog, setCatalog] = useState<IntegrationsCatalog>({
    items: [],
    warnings: [],
  })
  const [loadedKey, setLoadedKey] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [count, setCount] = useState(40)
  const requestKey = `${projectId}:${provider}:${refresh}:${connected}`
  const loading = !!projectId && connected && loadedKey !== requestKey
  useEffect(() => {
    if (!projectId || !connected) return
    let alive = true
    void activeRuntime()
      .rpc()
      .call("integrations.list", { project_id: projectId, provider })
      .then((value) => {
        if (alive) {
          setCatalog(value)
          setError("")
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e))
      })
      .finally(() => {
        if (alive) setLoadedKey(requestKey)
      })
    return () => {
      alive = false
    }
  }, [projectId, provider, refresh, connected, requestKey])
  const matches = (loading ? [] : catalog.items).filter(
    (item) =>
      item.kind === category &&
      `${item.name} ${item.id} ${item.description ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase())
  )
  async function change(item: Integration, action: IntegrationAction) {
    const runtime = activeRuntime()
    setBusy(item.id)
    setError("")
    setNotice("")
    try {
      const result = await runtime
        .rpc()
        .call("integrations.change", {
          project_id: projectId,
          provider,
          id: item.id,
          kind: item.kind,
          scope: item.scope,
          action,
        })
      setNotice(result.message)
      if (result.connections.length) {
        setCategory("connector")
        setNotice(
          `${result.message} Open the connector setup links to finish signing in.`
        )
        setCatalog((value) => ({
          ...value,
          items: [
            ...result.connections,
            ...value.items.filter(
              (item) => !result.connections.some((app) => app.id === item.id)
            ),
          ],
        }))
      } else setRefresh((value) => value + 1)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy("")
    }
  }
  async function login(item: Integration) {
    if (
      !thread ||
      thread.provider.kind !== provider ||
      thread.project_id !== projectId
    )
      return
    const owner = useStore
    const runtime = activeRuntime()
    setBusy(item.id)
    setError("")
    try {
      const terminal = await runtime
        .rpc()
        .call("integrations.login", { thread_id: thread.id, name: item.id })
      const startedAt = owner.getState().info?.started_at
      owner
        .getState()
        .set((state) => ({
          settingsOpen: false,
          rightOpen: true,
          rightTab: "terminal",
          terminalTabs: {
            ...state.terminalTabs,
            [thread.id]: [
              ...(state.terminalTabs[thread.id] ?? []),
              {
                key: terminal.id,
                title: `Connect ${item.name}`,
                kind: "shell",
                terminalId: terminal.id,
                daemonStartedAt: startedAt,
                connectorLogin: true,
              },
            ],
          },
          activeTerminalTab: {
            ...state.activeTerminalTab,
            [thread.id]: terminal.id,
          },
        }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy("")
    }
  }
  const openConnectors = () =>
    void openExternal(CONNECTORS_URL).catch((e) => setError(errorText(e)))
  const noun = category === "plugin" ? "plugin" : "connector"
  const canSignIn = provider === "claude-code" && category === "connector"
  const emptyTitle = !projectId
    ? "Select a project"
    : !connected
      ? "Not connected"
      : query
        ? "No matches"
        : `No ${noun}s yet`
  const emptyBody = !projectId
    ? "Choose a project to manage its plugins and connectors."
    : !connected
      ? "Connect your computer to load integrations."
      : query
        ? `Nothing matches “${query}”. Try a different search.`
        : category === "plugin"
          ? "Install a plugin skill in your agent, then refresh to see it here."
          : "Connect an app in your agent, then refresh to see it here."
  return (
    <div className="grid gap-5" data-integrations>
      <div className="flex flex-wrap items-center gap-2">
        <Picker disabled={!!busy} label={provider === "codex" ? "Codex" : "Claude Code"}>
          {(["claude-code", "codex"] as const).map((kind) => (
            <MenuItem
              key={kind}
              onClick={() => {
                setProvider(kind)
                setNotice("")
              }}
            >
              {kind === "codex" ? "Codex" : "Claude Code"}
            </MenuItem>
          ))}
        </Picker>
        <Picker disabled={!!busy} label={projects[projectId]?.name ?? "Select project"}>
          {Object.values(projects).map((project) => (
            <MenuItem key={project.id} onClick={() => setProjectId(project.id)}>
              {project.name}
            </MenuItem>
          ))}
        </Picker>
        <div className="ms-auto flex items-center gap-1">
          {canSignIn && (
            <Button variant="ghost" size="sm" onClick={openConnectors}>
              <ExternalLinkIcon className="size-3.5" />
              Add connector
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!connected || loading || !!busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCwIcon className="size-3.5" />
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="settings-segments" role="group" aria-label="Integration type">
          {(["plugin", "connector"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={category === kind}
              onClick={() => {
                setCategory(kind)
                setCount(40)
              }}
            >
              {kind === "plugin" ? "Plugins" : "Connectors"}
            </button>
          ))}
        </div>
        <InputGroup className="min-w-[12rem] flex-1">
          <InputGroupAddon>
            <SearchIcon className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Find integrations"
            placeholder={`Find a ${noun}`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCount(40)
            }}
          />
        </InputGroup>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {provider === "codex"
          ? "Type @ in a conversation to choose an installed plugin or connected app."
          : "Type / in a conversation to choose a plugin skill, such as /plugin:skill."}
      </p>

      {notice && (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {error}
        </p>
      )}
      {catalog.warnings.map((message) => (
        <p key={message} role="status" className="text-xs leading-relaxed text-muted-foreground">
          {message}
        </p>
      ))}

      {loading ? (
        <div className={cn(SETTINGS_CARD_CLASS_NAME, SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME)} aria-busy="true">
          {[0, 1, 2].map((row) => (
            <div key={row} className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "py-4")}>
              <div className="flex items-start gap-3">
                <div className="size-8 shrink-0 animate-pulse rounded-lg bg-[var(--color-background-button-secondary)]" />
                <div className="min-w-0 flex-1 space-y-2 py-0.5">
                  <div className="h-3.5 w-40 max-w-full animate-pulse rounded bg-[var(--color-background-button-secondary)]" />
                  <div className="h-3 w-full max-w-[22rem] animate-pulse rounded bg-[var(--color-background-button-secondary)]" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : !matches.length ? (
        <div className="usage-state !justify-items-start" role="status">
          <span className="flex size-9 items-center justify-center rounded-xl bg-[var(--color-background-button-secondary)] text-muted-foreground [&>svg]:size-[18px]">
            {category === "plugin" ? <PluginIcon /> : <McpIcon />}
          </span>
          <h2 className="font-medium">{emptyTitle}</h2>
          <p>{emptyBody}</p>
          {query ? (
            <Button size="sm" variant="chrome-outline" onClick={() => setQuery("")}>
              Clear search
            </Button>
          ) : canSignIn ? (
            <Button size="sm" variant="chrome-outline" onClick={openConnectors}>
              Add a Claude connector
            </Button>
          ) : null}
        </div>
      ) : (
        <div className={cn(SETTINGS_CARD_CLASS_NAME, SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME)}>
          {matches.slice(0, count).map((item) => {
            const canSignInHere =
              item.can_login &&
              (!thread ||
                thread.provider.kind !== provider ||
                thread.project_id !== projectId)
            return (
              <div
                key={`${item.kind}:${item.id}:${item.scope}`}
                className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "py-4")}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)] text-muted-foreground [&>svg]:size-4">
                    {item.kind === "plugin" ? <PluginIcon /> : <McpIcon />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="text-sm font-medium [overflow-wrap:anywhere]">{item.name}</h3>
                      {item.installed && (
                        <span className="inline-flex h-5 items-center rounded-full bg-[var(--color-background-elevated-secondary)] px-2 text-[11px] text-muted-foreground">
                          {item.enabled === false ? "Disabled" : "Installed"}
                        </span>
                      )}
                    </div>
                    {item.description && (
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                        {item.description}
                      </p>
                    )}
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      {item.status}
                      {item.scope ? ` · ${item.scope}` : ""}
                    </p>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {item.actions.map((action) => (
                        <Button
                          key={action}
                          size="chip"
                          variant="subtle"
                          disabled={!connected || !!busy}
                          onClick={() => void change(item, action)}
                        >
                          {busy === item.id ? "Working…" : labels[action]}
                        </Button>
                      ))}
                      {item.connect_url && (
                        <Button
                          size="chip"
                          variant="subtle"
                          onClick={() =>
                            void openExternal(item.connect_url!).catch((e) =>
                              setError(errorText(e))
                            )
                          }
                        >
                          {item.installed ? "Manage connection" : "Connect"}
                        </Button>
                      )}
                      {item.can_login && (
                        <Button
                          size="chip"
                          variant="subtle"
                          disabled={
                            !connected ||
                            !!busy ||
                            thread?.provider.kind !== provider ||
                            thread.project_id !== projectId
                          }
                          onClick={() => void login(item)}
                        >
                          Sign in
                        </Button>
                      )}
                    </div>
                    {canSignInHere && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Open a Claude conversation in this project to sign in.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {matches.length > count && (
        <Button variant="ghost" size="sm" onClick={() => setCount((value) => value + 40)}>
          Show more
        </Button>
      )}
    </div>
  )
}
function Picker({
  label,
  children,
  disabled,
}: {
  disabled?: boolean
  label: string
  children: React.ReactNode
}) {
  return (
    <Menu>
      <MenuTrigger disabled={disabled} render={<Button variant="chrome-outline" size="sm" />}>
        {label}
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <ComposerPickerMenuPopup>
        <MenuGroup>{children}</MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}
