// FILE: ModelPicker.tsx
// Purpose: The composer's agent / model / effort panel. One searchable list that
// stays usable from a 4-model catalog to a 600-model one: backends (or families)
// become sections, long sections collapse, favorites and recent picks sit on top,
// and a favorites view gathers starred models from every harness. Traits of the
// selected model sit under the list as an effort card (fast-mode bolt, effort
// label, reset, stepped slider) and one "Label  value >" menu row per other trait.
// The first nine model rows carry a mod+1..9 hint that picks them.
// Layer: Composer UI
// Exports: ModelPicker

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react"

import { openAddAccount } from "@/components/kybern/accounts/AddAccountSheet"
import { ProviderMark } from "@/components/kybern/bits"
import { FollowDefaultsLine, ModelPickerTabs } from "@/components/kybern/ModelPickerTabs"
import { TextSwap } from "@/components/kybern/motion"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { Kbd } from "@/components/kit/kbd"
import { COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME, COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { useLocalStorage } from "@/lib/hooks"
import { PROVIDER_LABEL, formatEffort, isMac, mod } from "@/lib/format"
import { ChevronRightIcon, FastModeIcon, FastModeOutlineIcon, RotateCcwIcon, SearchIcon, StarFilledIcon, StarIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { followLine, pickerTabs, type PickerTab } from "@/lib/accountUi"
import type { AccountSummary, ModelParameter, ProviderInstance, ProviderKind, ProviderModel, ProviderStatus } from "@/protocol"
import {
  MODEL_FLAT_LIMIT,
  MODEL_SECTION_PREVIEW,
  backendLabel,
  catalogBackends,
  changeTrait,
  customModelId,
  favoriteMatches,
  findModel,
  isFavoriteModel,
  modelSections,
  parameterSwitch,
  rememberModel,
  searchModels,
  selectedVariant,
  selectorEffort,
  toggleFavoriteModel,
  traitUnavailableReason,
  traitValues,
  type FavoriteModel,
  type ModelSection,
} from "../../../../../packages/kybern-client/src/models"

/** Search results render at most this many rows; the rest need a narrower query. */
const SEARCH_RESULT_LIMIT = 150
/** "Show more" reveals this many rows at a time so a 560-model backend never mounts at once. */
const SECTION_STEP = 100

/** Effort thumb diameter; the track is 4px shorter so the thumb sits just proud of it. */
const THUMB = 28

const PICKER_DIVIDER_CLASS_NAME = "mx-3 h-px shrink-0 bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)]"

type Row =
  | { kind: "default"; key: string }
  | { kind: "model"; key: string; harness: ProviderKind; model: ProviderModel; showBackend: boolean }
  | { kind: "more"; key: string; section: string; hidden: number }
  | { kind: "custom"; key: string; id: string }

type Block = { key: string; label: string | null; icon?: ProviderKind; rows: Row[] }

type PickerView = "all" | "favorites"

interface ModelPickerProps {
  /** The composer's trigger button; rendered as the popover trigger. */
  trigger: ReactElement
  provider: ProviderInstance
  providers: ProviderStatus[]
  instances?: Partial<Record<ProviderKind, string>>
  model?: string | null
  effort?: string | null
  canPickModel: boolean
  canPickProvider: boolean
  canReload: boolean
  loading: boolean
  busy: boolean
  onOpenChange?: (open: boolean) => void
  onModelChange: (model: string, effort: string | undefined) => Promise<boolean>
  onEffortChange: (effort: string) => Promise<boolean>
  /** `choice` is set when a favorite from another harness is picked; `pinAccount` when an account tab names the account. */
  onProviderChange: (provider: ProviderInstance, choice?: { model?: string; effort?: string; pinAccount?: boolean }) => Promise<boolean>
  /** Every account of every agent, for the tab strip. */
  accounts: AccountSummary[]
  /** The thread follows the project and global defaults; undefined for a draft, which has no override to follow. */
  accountFollowsDefaults?: boolean
  /** The account the tabs treat as current; defaults to the provider's own instance. */
  accountInstance?: string
  /** Pin the next message to an account of the current agent; `null` follows defaults again. */
  onAccountChange?: (instance: string | null) => Promise<boolean>
  onReload: () => void
  /** Open setup for an agent that can't run yet. */
  onSetUpProvider?: (kind: ProviderKind) => void
}

export function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        props.onOpenChange?.(next)
      }}
    >
      <PopoverPrimitive.Trigger render={props.trigger} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side="top" align="end" sideOffset={6} collisionPadding={8} className="z-50">
          <PopoverPrimitive.Popup
            aria-label="Agent and model"
            initialFocus={inputRef}
            className={cn(
              COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME,
              "flex w-[20rem] max-w-[min(20rem,calc(100vw-1rem))] origin-(--transform-origin) flex-col text-[var(--color-text-foreground)] outline-none",
              "transition-[opacity,scale,filter] duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)] data-ending-style:duration-[var(--duration-quick)] data-starting-style:scale-[var(--scale-medium)] data-starting-style:opacity-0 data-starting-style:blur-[var(--blur-small)] data-ending-style:scale-[var(--scale-tiny)] data-ending-style:opacity-0 motion-reduce:transition-none",
            )}
          >
            {open && <ModelPickerPanel {...props} inputRef={inputRef} close={() => setOpen(false)} />}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

function ModelPickerPanel({
  provider,
  providers,
  instances,
  model,
  effort,
  canPickModel,
  canPickProvider,
  canReload,
  loading,
  busy,
  onModelChange,
  onEffortChange,
  onProviderChange,
  accounts,
  accountFollowsDefaults,
  accountInstance,
  onAccountChange,
  onReload,
  onSetUpProvider,
  inputRef,
  close,
}: ModelPickerProps & { inputRef: React.RefObject<HTMLInputElement | null>; close: () => void }) {
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<Record<string, number>>({})
  const [recents, setRecents] = useLocalStorage<Record<string, string[]>>("kybern.model-recents", {})
  const [favorites, setFavorites] = useLocalStorage<FavoriteModel[]>("kybern.model-favorites", [])
  const [view, setView] = useLocalStorage<PickerView>("kybern.model-picker-view", "all")
  const showFavorites = view === "favorites"

  const status = providers.find((item) => item.kind === provider.kind)
  const catalog = useMemo(() => status?.models ?? [], [status?.models])
  const current = model ? findModel(catalog, model) : catalog.find((item) => item.is_default)
  const selectedId = model ? current?.id ?? model : ""
  const multiBackend = useMemo(() => catalogBackends(catalog).length > 1, [catalog])
  const large = catalog.length > MODEL_FLAT_LIMIT
  const agentName = status?.display_name ?? PROVIDER_LABEL[provider.kind]
  const effortValue = effort ?? selectorEffort(current, model) ?? current?.default_effort ?? null

  const results = useMemo(() => (query.trim() && !showFavorites ? searchModels(catalog, query) : []), [catalog, query, showFavorites])

  const blocks = useMemo<Block[]>(() => {
    const modelRow = (section: string, item: ProviderModel, showBackend = false, harness: ProviderKind = provider.kind): Row => ({
      kind: "model",
      key: `${section}:${harness}:${item.id}`,
      harness,
      model: item,
      showBackend,
    })
    const search = query.trim()

    if (showFavorites) {
      const out: Block[] = []
      for (const item of providers) {
        // Another harness's favorites are only reachable where the harness can change.
        if (!item.available || (item.kind !== provider.kind && !canPickProvider)) continue
        const starred = favorites
          .filter((favorite) => favorite.kind === item.kind && (favorite.instance ?? "default") === (item.kind === provider.kind ? provider.instance : instances?.[item.kind] ?? "default"))
          .map((favorite) => item.models?.find((entry) => favoriteMatches(favorite, entry)) ?? { id: favorite.id, display_name: favorite.id })
          // Older favorites name a variant; several can resolve to one row.
          .filter((entry, index, list) => list.findIndex((other) => other.id === entry.id) === index)
        const shown = search ? searchModels(starred, search) : starred
        if (!shown.length) continue
        const backends = catalogBackends(item.models ?? []).length > 1
        out.push({ key: `favorites:${item.kind}`, label: item.display_name, icon: item.kind, rows: shown.map((entry) => modelRow("favorites", entry, backends, item.kind)) })
      }
      return out
    }

    if (search) {
      const shown = results.slice(0, SEARCH_RESULT_LIMIT)
      const out: Block[] = []
      if ("agent default".includes(search.toLowerCase())) out.push({ key: "default", label: null, rows: [{ kind: "default", key: "default" }] })
      const sections: ModelSection<ProviderModel>[] = multiBackend
        ? modelSections(shown)
        : [{ key: "results", label: null, models: shown }]
      for (const section of sections) {
        out.push({ key: section.key, label: section.label, rows: section.models.map((item) => modelRow(section.key, item)) })
      }
      // Offer the raw text as an ID when nothing matches or it already looks like one.
      const custom = customModelId(search)
      if (custom && !catalog.some((item) => item.id === custom) && (!results.length || /[/:.@-]/.test(custom))) {
        out.push({ key: "custom", label: null, rows: [{ kind: "custom", key: "custom", id: custom }] })
      }
      return out
    }

    const out: Block[] = [{ key: "default", label: null, rows: [{ kind: "default", key: "default" }] }]
    if (model && !current) {
      out[0]!.rows.push({ kind: "custom", key: "current-custom", id: model })
    }
    const sections = modelSections(catalog)
    const grouped = sections.length > 1
    if (grouped) {
      const starred = catalog.filter((item) => isFavoriteModel(favorites, provider.kind, item, provider.instance))
      if (starred.length) out.push({ key: "starred", label: "Favorites", rows: starred.map((item) => modelRow("starred", item, multiBackend)) })
      const recent = (recents[`${provider.kind}:${provider.instance}`] ?? (provider.instance === "default" ? recents[provider.kind] : undefined) ?? [])
        .map((id) => findModel(catalog, id))
        .filter((item): item is ProviderModel => !!item && !isFavoriteModel(favorites, provider.kind, item, provider.instance))
        .filter((item, index, list) => list.indexOf(item) === index)
      if (recent.length) out.push({ key: "recent", label: "Recent", rows: recent.map((item) => modelRow("recent", item, multiBackend)) })
    }
    for (const section of sections) {
      const limit = grouped && large ? expanded[section.key] ?? MODEL_SECTION_PREVIEW : section.models.length
      const rows: Row[] = section.models.slice(0, limit).map((item) => modelRow(section.key, item))
      const hidden = section.models.length - limit
      if (hidden > 0) rows.push({ kind: "more", key: `${section.key}:more`, section: section.key, hidden })
      out.push({ key: section.key, label: section.label, rows })
    }
    return out
  }, [canPickProvider, catalog, current, expanded, favorites, large, model, multiBackend, provider.kind, provider.instance, providers, instances, query, recents, results, showFavorites])

  const isSelected = (row: Row) =>
    row.kind === "default" ? !selectedId
      : row.kind === "model" ? row.harness === provider.kind && row.model.id === selectedId
        : row.kind === "custom" && row.id === selectedId
  const searchTotal = results.length
  const rows = useMemo(() => blocks.flatMap((block) => block.rows), [blocks])
  const selectedIndex = rows.findIndex(isSelected)
  // Null follows the list: the best match while searching, otherwise the selection.
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const activeRow = rows.find((row) => row.key === activeKey) ?? (query.trim() ? rows[0] : rows[selectedIndex] ?? rows[0])

  useEffect(() => {
    if (!activeRow) return
    listRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(activeRow.key)}"]`)?.scrollIntoView({ block: "nearest" })
  }, [activeRow])

  const star = (row: Row) => {
    if (row.kind === "model") setFavorites((value) => toggleFavoriteModel(value, row.harness, row.model, row.harness === provider.kind ? provider.instance : instances?.[row.harness] ?? "default"))
  }

  const pick = async (row: Row) => {
    if (busy) return
    if (row.kind === "more") {
      setExpanded((value) => ({ ...value, [row.section]: (value[row.section] ?? MODEL_SECTION_PREVIEW) + SECTION_STEP }))
      return
    }
    if (row.kind === "default") {
      if (await onModelChange("", undefined)) close()
      return
    }
    // Picking the model already in use keeps its traits.
    const held = row.kind === "model" && row.harness === provider.kind && row.model.id === selectedId && model ? selectedVariant(row.model, model) : undefined
    const id = row.kind === "model" ? held?.id ?? row.model.id : row.id
    // The held combination can offer other efforts than the row's default one.
    const nextEfforts = held?.efforts?.length ? held.efforts : row.kind === "model" ? row.model.efforts ?? [] : []
    // Keep the chosen effort when the new model offers it; otherwise its own default.
    const nextEffort = effortValue && nextEfforts.includes(effortValue)
      ? effortValue
      : held?.default_effort ?? (row.kind === "model" ? row.model.default_effort ?? undefined : undefined)
    const harness = row.kind === "model" ? row.harness : provider.kind
    const saved = harness === provider.kind
      ? await onModelChange(id, nextEffort)
      : await onProviderChange({ kind: harness, instance: instances?.[harness] ?? "default" }, { model: id, effort: nextEffort })
    if (saved) {
      setRecents((value) => ({ ...value, [`${harness}:${harness === provider.kind ? provider.instance : instances?.[harness] ?? "default"}`]: rememberModel(value[`${harness}:${harness === provider.kind ? provider.instance : instances?.[harness] ?? "default"}`] ?? [], row.kind === "model" ? row.model.id : id) }))
      close()
    }
  }

  // The first nine model rows pick with mod+1..9, from anywhere in the open panel.
  const shortcutRows = useMemo(() => rows.filter((row): row is Extract<Row, { kind: "model" }> => row.kind === "model").slice(0, 9), [rows])
  const pickShortcut = useRef<(index: number) => void>(() => {})
  useEffect(() => {
    pickShortcut.current = (index) => {
      const row = shortcutRows[index]
      if (row) void pick(row)
    }
  })
  useEffect(() => {
    const onWindowKey = (event: KeyboardEvent) => {
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.shiftKey || event.altKey || !/^[1-9]$/.test(event.key)) return
      event.preventDefault()
      pickShortcut.current(Number(event.key) - 1)
    }
    window.addEventListener("keydown", onWindowKey)
    return () => window.removeEventListener("keydown", onWindowKey)
  }, [])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!rows.length) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      const index = activeRow ? rows.indexOf(activeRow) : -1
      setActiveKey(rows[(index + step + rows.length) % rows.length]!.key)
    } else if (event.key === "Enter" && activeRow) {
      event.preventDefault()
      void pick(activeRow)
    } else if (event.key.toLowerCase() === "d" && (isMac ? event.metaKey : event.ctrlKey) && activeRow?.kind === "model") {
      event.preventDefault()
      star(activeRow)
    }
  }

  const tabs = useMemo(
    () => pickerTabs({ agents: providers.map((item) => ({ kind: item.kind, display_name: item.display_name, available: item.available })), accounts, current: { kind: provider.kind, instance: accountInstance ?? provider.instance }, canPickProvider, starredView: showFavorites }),
    [accountInstance, accounts, canPickProvider, provider.kind, provider.instance, providers, showFavorites],
  )
  const follow = followLine({ accounts, current: { kind: provider.kind, instance: accountInstance ?? provider.instance }, followsDefaults: accountFollowsDefaults })

  const resetList = () => {
    setQuery("")
    setExpanded({})
    setActiveKey(null)
  }

  const selectAccountTab = async (tab: Extract<PickerTab, { type: "account" }>) => {
    if (busy) return
    // An agent that isn't set up leads to its setup; an account that needs
    // signing in leads to the sign-in sheet. Neither changes the thread.
    if (tab.notSetUp && onSetUpProvider) {
      close()
      onSetUpProvider(tab.kind)
      return
    }
    if (tab.needsSignIn) {
      close()
      openAddAccount({ kind: tab.kind, instance: tab.instance })
      return
    }
    if (tab.notSetUp) return
    if (tab.kind === provider.kind) {
      setView("all")
      if (tab.instance !== (accountInstance ?? provider.instance) || (accountFollowsDefaults && tab.multi)) {
        resetList()
        if (onAccountChange) await onAccountChange(tab.instance)
        else await onProviderChange({ kind: tab.kind, instance: tab.instance })
      }
      inputRef.current?.focus()
      return
    }
    setView("all")
    resetList()
    await onProviderChange({ kind: tab.kind, instance: tab.instance }, tab.multi ? { pinAccount: true } : undefined)
    inputRef.current?.focus()
  }

  const selectStarred = () => {
    setView("favorites")
    setActiveKey(null)
    inputRef.current?.focus()
  }

  return (
    <>
      <ModelPickerTabs tabs={tabs} busy={busy} canReload={canPickModel && canReload} loading={loading} onStarred={selectStarred} onAccount={(tab) => void selectAccountTab(tab)} onReload={onReload} />
      {follow && <FollowDefaultsLine line={follow} busy={busy} onFollow={() => void onAccountChange?.(null)} />}

      {canPickModel && (
        <>
          <label className="flex h-9 items-center gap-2 px-3">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeRow ? `${listId}-${activeRow.key}` : undefined}
              aria-label={showFavorites ? "Search favorites" : `Search ${agentName} models`}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveKey(null)
              }}
              onKeyDown={onKeyDown}
              placeholder={showFavorites ? "Search favorites" : `Search ${agentName} models`}
              className="min-w-0 flex-1 bg-transparent !font-sans text-[length:var(--app-font-size-ui,12px)] outline-none placeholder:text-muted-foreground/50"
            />
          </label>
          <div aria-hidden className={PICKER_DIVIDER_CLASS_NAME} />

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={showFavorites ? "Favorite models" : `${agentName} models`}
            className={cn(
              "flex flex-col overflow-y-auto overscroll-contain p-1",
              COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
              // A large catalog keeps one height so the panel doesn't jump while typing.
              large && !showFavorites ? "h-[min(21rem,50vh)]" : "max-h-[min(21rem,50vh)]",
            )}
          >
            {blocks.map((block) => (
              <div key={block.key} role="group" aria-label={block.label ?? undefined}>
                {block.label && (
                  <div className="flex items-center gap-1.5 px-2 pb-1 pt-2.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/50">
                    {block.icon && <ProviderMark kind={block.icon} size={11} className="size-[11px] opacity-80" />}
                    <span className="truncate">{block.label}</span>
                  </div>
                )}
                {block.rows.map((row) => (
                  <PickerRow
                    key={row.key}
                    id={`${listId}-${row.key}`}
                    row={row}
                    agentName={agentName}
                    active={row === activeRow}
                    shortcut={row.kind === "model" && shortcutRows.includes(row) ? shortcutRows.indexOf(row) + 1 : undefined}
                    selected={isSelected(row)}
                    favorite={row.kind === "model" && isFavoriteModel(favorites, row.harness, row.model, row.harness === provider.kind ? provider.instance : instances?.[row.harness] ?? "default")}
                    starOnHover={showFavorites}
                    onHover={() => setActiveKey(row.key)}
                    onPick={() => void pick(row)}
                    onStar={() => star(row)}
                  />
                ))}
              </div>
            ))}
            {showFavorites && !rows.length && (
              <p className="px-6 py-7 text-center text-[length:var(--app-font-size-ui,12px)] leading-relaxed text-muted-foreground/70 [text-wrap:balance]">
                {query.trim() ? `No favorites match “${query.trim()}”` : "Star a model to keep it here, whichever agent it belongs to."}
              </p>
            )}
            {!showFavorites && query.trim() && searchTotal === 0 && !blocks.some((block) => block.key === "custom") && (
              <p className="px-2 py-6 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/70">No models match “{query.trim()}”</p>
            )}
            {!showFavorites && searchTotal > SEARCH_RESULT_LIMIT && (
              <p className="px-2 pb-1.5 pt-2 text-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/50">
                Showing {SEARCH_RESULT_LIMIT} of {searchTotal}. Add a word to narrow the list.
              </p>
            )}
            {!showFavorites && catalog.length === 0 && !query.trim() && (
              <p className="px-2 pb-2 pt-1 text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-muted-foreground/60">
                {loading ? "Loading models…" : `${agentName} didn’t list any models. It uses its own setting until you reload or enter an ID.`}
              </p>
            )}
          </div>
        </>
      )}

      {canPickModel && (
        <ModelFooter
          current={current}
          model={model}
          effort={effort}
          fallbackEfforts={status?.supported_efforts}
          busy={busy}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
        />
      )}
    </>
  )
}

/** The trait that gets the lightning-bolt toggle: an on/off parameter about speed. */
const isFastParameter = (parameter: ModelParameter) => !!parameterSwitch(parameter) && /fast|speed/i.test(`${parameter.id} ${parameter.label}`)

/**
 * Traits of the selected model. A model with traits is one row, so the variant
 * a thread holds decides which efforts apply. Effort and fast mode share one
 * card; every other trait is a "Label  value >" menu row.
 */
function ModelFooter({
  current,
  model,
  effort,
  fallbackEfforts,
  busy,
  onModelChange,
  onEffortChange,
}: {
  current: ProviderModel | undefined
  model?: string | null
  effort?: string | null
  fallbackEfforts?: string[]
  busy: boolean
  onModelChange: (model: string, effort: string | undefined) => Promise<boolean>
  onEffortChange: (effort: string) => Promise<boolean>
}) {
  const variant = selectedVariant(current, model)
  const efforts = current ? (variant?.efforts?.length ? variant.efforts : current.efforts ?? []) : fallbackEfforts ?? []
  const defaultEffort = variant?.default_effort ?? current?.default_effort ?? null
  // Older GPT threads kept their reasoning level inside the model selector.
  const effortValue = effort ?? selectorEffort(current, model) ?? defaultEffort
  const parameters = current?.parameters ?? []
  const traits = traitValues(current, model)
  // Shown until the parent reports the new variant; cleared on failure.
  const [pending, setPending] = useState<{ id: string; value: string; from: string | undefined } | null>(null)
  const shown = pending && pending.from === variant?.id ? { ...traits, [pending.id]: pending.value } : traits

  const change = async (parameter: string, value: string) => {
    if (!current || busy || traits[parameter] === value) return
    const next = changeTrait(current, model, parameter, value)
    if (!next) return
    const nextEfforts = next.efforts?.length ? next.efforts : current.efforts ?? []
    // Keep the chosen effort when the new combination offers it; otherwise its own default.
    const nextEffort = effortValue && nextEfforts.includes(effortValue) ? effortValue : next.default_effort ?? current.default_effort ?? undefined
    setPending({ id: parameter, value, from: variant?.id })
    if (!(await onModelChange(next.id, nextEffort))) setPending(null)
  }

  const fast = parameters.find(isFastParameter)
  const fastToggle = fast ? parameterSwitch(fast)! : null
  const fastOn = !!fast && !!fastToggle && (shown[fast.id] ?? fast.default) === fastToggle.on
  const fastReason = fast && fastToggle && current ? traitUnavailableReason(current, model, fast.id, fastOn ? fastToggle.off : fastToggle.on) : null
  const rows = parameters.filter((parameter) => parameter !== fast)
  const hasEffort = efforts.length > 1

  // Differs from what the model starts with: any trait off its default, or another effort.
  const traitsChanged = parameters.some((parameter) => (shown[parameter.id] ?? parameter.default) !== parameter.default)
  const effortChanged = hasEffort && !!defaultEffort && effortValue !== defaultEffort
  const reset = async () => {
    if (!current || busy) return
    let selector: string | null | undefined = model
    let target = variant
    for (const parameter of parameters) {
      if (traitValues(current, selector)[parameter.id] === parameter.default) continue
      const next = changeTrait(current, selector, parameter.id, parameter.default)
      if (next) {
        selector = next.id
        target = next
      }
    }
    const nextDefault = (hasEffort ? target?.default_effort ?? current.default_effort : undefined) ?? undefined
    if (selector !== model) {
      setPending(null)
      await onModelChange(selector!, nextDefault)
    } else if (effortChanged && defaultEffort) {
      await onEffortChange(defaultEffort)
    }
  }
  const resetButton = traitsChanged || effortChanged ? <ResetButton busy={busy} onReset={() => void reset()} /> : null
  const fastButton = fast && fastToggle && (
    <FastToggle
      on={fastOn}
      busy={busy}
      reason={fastReason}
      onToggle={() => {
        if (fastReason) return
        void change(fast.id, fastOn ? fastToggle.off : fastToggle.on)
      }}
    />
  )

  if (!rows.length && !hasEffort && !fast) return null
  return (
    <>
      <div aria-hidden className={PICKER_DIVIDER_CLASS_NAME} />
      {hasEffort ? (
        <EffortSlider efforts={efforts} value={effortValue} disabled={busy} leading={fastButton} trailing={resetButton} onChange={onEffortChange} />
      ) : fast ? (
        <div className={cn("px-3 pb-1 pt-2.5 transition-opacity duration-150", busy && "opacity-60")}>
          <CardHeader leading={fastButton} trailing={resetButton}>
            <span className={cn("font-medium transition-colors duration-150", fastOn ? "text-[var(--effort-accent)]" : "text-muted-foreground/60")}>{fastOn ? "Fast" : "Standard"}</span>
          </CardHeader>
        </div>
      ) : null}
      {rows.length > 0 && (
        <div className={cn("flex flex-col px-1 pb-1 transition-opacity duration-150", hasEffort || fast ? "pt-0.5" : "pt-1", busy && "opacity-60")}>
          {rows.map((parameter) => (
            <TraitRow
              key={parameter.id}
              parameter={parameter}
              value={shown[parameter.id] ?? parameter.default}
              busy={busy}
              unavailable={(value) => (current ? traitUnavailableReason(current, model, parameter.id, value) : null)}
              onChange={(value) => void change(parameter.id, value)}
            />
          ))}
        </div>
      )}
      {!hasEffort && !fast && <div className="h-0.5" />}
    </>
  )
}

const EFFORT_ACCENT_CLASS_NAME = "[--effort-accent:oklch(0.62_0.1_255)] dark:[--effort-accent:oklch(0.76_0.08_255)]"

/** Bolt on the left, state in the middle, reset on the right; each end is a fixed 24px slot so the label never shifts. */
function CardHeader({ leading, trailing, children }: { leading?: React.ReactNode; trailing?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn("mb-1.5 grid min-h-6 grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] items-center gap-2 text-[length:var(--app-font-size-ui,12px)]", EFFORT_ACCENT_CLASS_NAME)}>
      <span className="flex justify-start">{leading}</span>
      <span className="truncate text-center">{children}</span>
      <span className="flex justify-end">{trailing}</span>
    </div>
  )
}

const CARD_ICON_BUTTON_CLASS_NAME =
  "press-row -mx-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[0.4rem] outline-none transition-[color,opacity] duration-150 focus-visible:ring-1 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-50"

/**
 * Fast mode as a lightning bolt: tinted when on, muted when off. Like the rest
 * of the picker it is `aria-disabled` while busy or unavailable, which keeps focus.
 */
function FastToggle({ on, busy, reason, onToggle }: { on: boolean; busy: boolean; reason: string | null; onToggle: () => void }) {
  const Icon = on ? FastModeIcon : FastModeOutlineIcon
  const button = (
    <button
      type="button"
      aria-label="Fast mode"
      aria-pressed={on}
      aria-disabled={busy || !!reason || undefined}
      onClick={() => {
        if (!busy) onToggle()
      }}
      className={cn(CARD_ICON_BUTTON_CLASS_NAME, on ? "text-[var(--effort-accent)]" : "text-muted-foreground/60 hover:text-foreground")}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  )
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="top" sideOffset={8} variant="picker">{reason ?? "Fast mode"}</TooltipPopup>
    </Tooltip>
  )
}

/** Puts effort and every trait back to the model's defaults. */
function ResetButton({ busy, onReset }: { busy: boolean; onReset: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Reset to default"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onReset()
            }}
            className={cn(CARD_ICON_BUTTON_CLASS_NAME, "text-muted-foreground/60 hover:text-foreground")}
          >
            <RotateCcwIcon className="size-3.5" aria-hidden />
          </button>
        }
      />
      <TooltipPopup side="top" sideOffset={8} variant="picker">Reset to default</TooltipPopup>
    </Tooltip>
  )
}

/**
 * One model trait other than effort and fast mode: "Label  value >" opens a
 * small menu of its values. Values the other traits rule out stay listed,
 * disabled, with the reason underneath. While busy the row ignores input and
 * stays `aria-disabled` rather than `disabled`, which drops focus in WebKit.
 */
function TraitRow({
  parameter,
  value,
  busy,
  unavailable,
  onChange,
}: {
  parameter: ModelParameter
  value: string
  busy: boolean
  /** The reason a value cannot be chosen with the other traits as they are, or null. */
  unavailable: (value: string) => string | null
  onChange: (value: string) => void
}) {
  const labelId = useId()
  const [open, setOpen] = useState(false)
  const labelOf = (item: string) => parameter.values.find((entry) => entry.value === item)?.label ?? item
  return (
    <Menu open={open && !busy} onOpenChange={(next) => setOpen(next && !busy)}>
      <MenuTrigger
        aria-labelledby={labelId}
        aria-disabled={busy || undefined}
        className="press-row flex h-8 w-full min-w-0 cursor-default items-center justify-between gap-3 rounded-[0.4rem] px-2 text-left text-[length:var(--app-font-size-ui,12px)] outline-none hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-ring aria-disabled:cursor-not-allowed data-popup-open:bg-[var(--color-background-button-secondary-hover)]"
      >
        <span id={labelId} className="shrink-0">{parameter.label}</span>
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground/70">
          <span className="truncate">{labelOf(value)}</span>
          <ChevronRightIcon className="size-3 shrink-0 opacity-70" aria-hidden />
        </span>
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="top">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(String(next))}>
          {parameter.values.map((entry) => {
            const reason = unavailable(entry.value)
            return (
              <MenuRadioItem key={entry.value} value={entry.value} disabled={!!reason} title={reason ?? undefined}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{entry.label}</span>
                  {reason && <span className="whitespace-normal text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-muted-foreground/70">{reason}</span>}
                </span>
              </MenuRadioItem>
            )
          })}
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

/**
 * Effort as a stepped slider: one dot per level, the fill trails an
 * oversized thumb. A press glides the thumb to the pointer, a drag follows it
 * 1:1, and release settles on the nearest level with a soft spring. Keys move
 * instantly. The change is committed once, on release or by key.
 */
function EffortSlider({
  efforts,
  value,
  disabled,
  leading,
  trailing,
  onChange,
}: {
  efforts: string[]
  value: string | null
  disabled: boolean
  leading?: React.ReactNode
  trailing?: React.ReactNode
  onChange: (effort: string) => Promise<boolean>
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  // settle: spring to a level; press: spring to the pointer; track: glued to it; key: no motion.
  const [motion, setMotion] = useState<"settle" | "press" | "track" | "key">("settle")
  // Shown until the parent reports the new value; cleared on failure.
  const [pending, setPending] = useState<{ effort: string; from: string | null } | null>(null)
  const shown = pending && pending.from === value ? pending.effort : value
  const max = efforts.length - 1
  const index = Math.max(0, efforts.indexOf(shown ?? ""))
  const t = drag ?? index / max
  const live = drag === null ? index : Math.round(drag * max)
  const label = efforts[live]!
  const held = drag !== null

  const ratio = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left - THUMB / 2) / (rect.width - THUMB)))
  }
  const commit = async (next: number) => {
    const effort = efforts[Math.min(max, Math.max(0, next))]!
    if (effort === shown) return
    setPending({ effort, from: value })
    if (!(await onChange(effort))) setPending(null)
  }

  return (
    <div className={cn("px-3 pb-2.5 pt-2.5 transition-opacity duration-150", disabled && "opacity-60")}>
      <CardHeader leading={leading} trailing={trailing}>
        <TextSwap text={formatEffort(label)} render={(text) => <span className="font-medium text-[var(--effort-accent)]">{text}</span>} />
      </CardHeader>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={live}
        aria-valuetext={formatEffort(label)}
        aria-disabled={disabled || undefined}
        data-held={held || undefined}
        style={{
          "--t": t,
          "--move-duration": motion === "track" ? "70ms" : motion === "key" ? "0ms" : "var(--duration-spring)",
          "--move-ease": motion === "track" ? "var(--ease-out)" : "var(--ease-spring)",
        } as CSSProperties}
        className={cn(
          "group/slider relative h-7 touch-none select-none rounded-full outline-none [container-type:inline-size]",
          "[--effort-fill:oklch(0.68_0.1_255)] dark:[--effort-fill:oklch(0.72_0.085_255)]",
          "focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--effort-fill)_45%,transparent)]",
          disabled ? "cursor-default" : held ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          setMotion("press")
          setDrag(ratio(event.clientX))
        }}
        onPointerMove={(event) => {
          if (drag === null) return
          setMotion("track")
          setDrag(ratio(event.clientX))
        }}
        onPointerUp={(event) => {
          if (drag === null) return
          const next = Math.round(ratio(event.clientX) * max)
          setMotion("settle")
          setDrag(null)
          void commit(next)
        }}
        onPointerCancel={() => {
          setMotion("settle")
          setDrag(null)
        }}
        onKeyDown={(event) => {
          if (disabled) return
          const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0
          if (step || event.key === "Home" || event.key === "End") {
            event.preventDefault()
            setMotion("key")
            void commit(event.key === "Home" ? 0 : event.key === "End" ? max : index + step)
          }
        }}
      >
        {/* Track: thinner than the thumb so the thumb sits proud of it. */}
        <div aria-hidden className="absolute inset-x-0 top-0.5 h-6 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]">
          <div
            className="absolute inset-0 rounded-full bg-[var(--effort-fill)] [transition:clip-path_var(--move-duration)_var(--move-ease)] motion-reduce:transition-none"
            style={{ clipPath: `inset(0 calc((100% - ${THUMB}px) * (1 - var(--t))) 0 0 round 999px)` }}
          />
          {efforts.map((item, i) => (
            <span
              key={item}
              className={cn(
                "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150",
                i / max <= t + 0.001 ? "bg-white/65" : "bg-[color-mix(in_srgb,var(--foreground)_22%,transparent)]",
              )}
              style={{ left: `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${i / max})` }}
            />
          ))}
        </div>
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-0 top-0 size-7 rounded-full bg-white",
            "shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.16),0_3px_8px_-1px_rgba(0,0,0,0.18)]",
            // A deeper shadow fades in while held, so the thumb reads as lifted.
            "after:absolute after:inset-0 after:rounded-full after:opacity-0 after:shadow-[0_6px_14px_-2px_rgba(0,0,0,0.28)] after:transition-opacity after:duration-200 group-data-held/slider:after:opacity-100",
            "[transition:transform_var(--move-duration)_var(--move-ease),scale_200ms_var(--ease-out)] group-data-held/slider:scale-[1.06] motion-reduce:transition-none",
          )}
          style={{ transform: `translateX(calc((100cqw - ${THUMB}px) * var(--t)))` }}
        />
      </div>
    </div>
  )
}

/**
 * One model row. The selected model keeps a soft fill instead of a checkmark,
 * which leaves the trailing edge to a single accessory: the favorite star,
 * with its own hit area apart from the row's.
 */
function PickerRow({
  id,
  row,
  agentName,
  active,
  shortcut,
  selected,
  favorite,
  starOnHover,
  onHover,
  onPick,
  onStar,
}: {
  id: string
  row: Row
  agentName: string
  active: boolean
  /** 1 to 9: picks this row with the mod key. */
  shortcut?: number
  selected: boolean
  favorite: boolean
  /** In the favorites view every row is starred, so the star only appears to unstar. */
  starOnHover: boolean
  onHover: () => void
  onPick: () => void
  onStar: () => void
}) {
  const base = cn(
    "flex w-full min-w-0 cursor-default select-none items-center gap-2 rounded-[0.4rem] px-2 text-left text-[length:var(--app-font-size-ui,12px)] outline-none",
    selected
      ? "bg-[var(--color-background-button-secondary)] text-foreground"
      : active && "bg-[var(--color-background-button-secondary-hover)]",
  )
  if (row.kind === "more") {
    return (
      <div id={id} data-row-key={row.key} role="option" aria-selected={false} onMouseMove={onHover} onClick={onPick} className={cn(base, "h-7 text-muted-foreground/60")}>
        <span className="truncate">Show {Math.min(row.hidden, SECTION_STEP)} more</span>
      </div>
    )
  }
  let title: string
  let detail: string | null = null
  let description: string | null = null
  let hint: string | undefined
  if (row.kind === "default") {
    title = "Agent default"
    hint = `Uses the model set in ${agentName}`
  } else if (row.kind === "custom") {
    title = row.id
    detail = selected ? "Custom ID" : "Use as model ID"
  } else {
    title = row.model.display_name
    description = row.model.description ?? null
    // Backend sections are headed by their backend; Favorites and Recent mix them.
    detail = row.showBackend && row.model.provider ? backendLabel(row.model.provider) : null
    hint = description ?? row.model.id
  }
  return (
    <div
      id={id}
      data-row-key={row.key}
      role="option"
      aria-selected={selected}
      title={hint}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn(base, description ? "min-h-[2.375rem] py-1" : "h-7")}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate">{title}</span>
          {detail && <span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/50">{detail}</span>}
        </span>
        {description && <span className="truncate text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-muted-foreground/50">{description}</span>}
      </span>
      {shortcut && (
        <Kbd aria-hidden className="h-[1.125rem] min-w-0 shrink-0 gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums">
          {isMac ? mod : `${mod} `}
          {shortcut}
        </Kbd>
      )}
      {row.kind === "model" && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
          aria-pressed={favorite}
          title={`${favorite ? "Remove from favorites" : "Add to favorites"} (${mod}D)`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            onStar()
          }}
          className={cn(
            // A 24px target that bleeds into the row padding, so the glyph stays on the row's edge.
            "press-row -my-1 -me-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[0.3rem] outline-none transition-[color,opacity] duration-150",
            favorite ? "text-[var(--color-accent-yellow)]" : "text-muted-foreground/50 hover:text-foreground",
            (favorite && !starOnHover) || active ? "opacity-100" : "opacity-0",
          )}
        >
          {favorite ? <StarFilledIcon className="size-3" /> : <StarIcon className="size-3" />}
        </button>
      )}
    </div>
  )
}
