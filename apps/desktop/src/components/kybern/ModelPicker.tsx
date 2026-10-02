// FILE: ModelPicker.tsx
// Purpose: The composer's agent / model / effort panel. One searchable list that
// stays usable from a 4-model catalog to a 600-model one: backends (or families)
// become sections, long sections collapse, favorites and recent picks sit on top,
// and a favorites view gathers starred models from every harness. Effort is a
// stepped slider under the list.
// Layer: Composer UI
// Exports: ModelPicker

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react"

import { ProviderMark, Spinner } from "@/components/kybern/bits"
import { TextSwap } from "@/components/kybern/motion"
import { COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME, COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { useLocalStorage } from "@/lib/hooks"
import { PROVIDER_LABEL, formatEffort, isMac, mod } from "@/lib/format"
import { RefreshCwIcon, SearchIcon, StarFilledIcon, StarIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ProviderInstance, ProviderKind, ProviderModel, ProviderStatus } from "@/protocol"
import {
  MODEL_FLAT_LIMIT,
  MODEL_SECTION_PREVIEW,
  backendLabel,
  catalogBackends,
  customModelId,
  findModel,
  isFavorite,
  modelSections,
  rememberModel,
  searchModels,
  toggleFavorite,
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
const PICKER_ICON_BUTTON_CLASS_NAME = "press-row inline-flex size-7 shrink-0 items-center justify-center rounded-[0.4rem] text-muted-foreground/60 outline-none transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:hover:bg-transparent"

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
  /** `choice` is set when a favorite from another harness is picked. */
  onProviderChange: (provider: ProviderInstance, choice?: { model?: string; effort?: string }) => Promise<boolean>
  onReload: () => void
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
  onReload,
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
  const efforts = current?.efforts?.length ? current.efforts : status?.supported_efforts ?? []
  const effortValue = effort ?? current?.default_effort ?? null

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
          .filter((favorite) => favorite.kind === item.kind)
          .map((favorite) => item.models?.find((entry) => entry.id === favorite.id) ?? { id: favorite.id, display_name: favorite.id })
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
      const starred = catalog.filter((item) => isFavorite(favorites, provider.kind, item.id))
      if (starred.length) out.push({ key: "starred", label: "Favorites", rows: starred.map((item) => modelRow("starred", item, multiBackend)) })
      const recent = (recents[provider.kind] ?? [])
        .filter((id) => !isFavorite(favorites, provider.kind, id))
        .map((id) => catalog.find((item) => item.id === id))
        .filter((item): item is ProviderModel => !!item)
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
  }, [canPickProvider, catalog, current, expanded, favorites, large, model, multiBackend, provider.kind, providers, query, recents, results, showFavorites])

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
    if (row.kind === "model") setFavorites((value) => toggleFavorite(value, row.harness, row.model.id))
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
    const id = row.kind === "model" ? row.model.id : row.id
    const nextEfforts = row.kind === "model" ? row.model.efforts ?? [] : []
    // Keep the chosen effort when the new model offers it; otherwise its own default.
    const nextEffort = effortValue && nextEfforts.includes(effortValue)
      ? effortValue
      : row.kind === "model" ? row.model.default_effort ?? undefined : undefined
    const harness = row.kind === "model" ? row.harness : provider.kind
    const saved = harness === provider.kind
      ? await onModelChange(id, nextEffort)
      : await onProviderChange({ kind: harness, instance: "default" }, { model: id, effort: nextEffort })
    if (saved) {
      setRecents((value) => ({ ...value, [harness]: rememberModel(value[harness] ?? [], id) }))
      close()
    }
  }

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

  const switchAgent = async (kind: ProviderStatus["kind"]) => {
    if (kind === provider.kind || busy) return
    setQuery("")
    setExpanded({})
    setActiveKey(null)
    await onProviderChange({ kind, instance: "default" })
    inputRef.current?.focus()
  }

  const toggleView = () => {
    setView(showFavorites ? "all" : "favorites")
    setActiveKey(null)
    inputRef.current?.focus()
  }

  return (
    <>
      <div className="flex items-center gap-0.5 px-1.5 pt-1.5">
        {canPickProvider && (
          <div role="radiogroup" aria-label="Agent" className="flex min-w-0 items-center gap-0.5">
            {providers.map((item) => {
              const selected = item.kind === provider.kind
              return (
                <Tooltip key={item.kind}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={item.display_name}
                        disabled={!item.available || busy}
                        onClick={() => void switchAgent(item.kind)}
                        className={cn(
                          "press-row inline-flex size-7 shrink-0 items-center justify-center rounded-[0.4rem] outline-none transition-[background-color,opacity] duration-150 focus-visible:ring-1 focus-visible:ring-ring",
                          selected
                            ? "bg-[var(--color-background-button-secondary)]"
                            : "opacity-45 hover:bg-[var(--color-background-button-secondary-hover)] hover:opacity-100 disabled:opacity-20 disabled:hover:bg-transparent",
                        )}
                      />
                    }
                  >
                    <ProviderMark kind={item.kind} size={14} className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top" sideOffset={6} variant="picker">
                    {item.available ? item.display_name : `${item.display_name} isn’t installed`}
                  </TooltipPopup>
                </Tooltip>
              )
            })}
          </div>
        )}
        {canPickModel && (
          <div className="ms-auto flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Show favorites only"
                    aria-pressed={showFavorites}
                    onClick={toggleView}
                    className={cn(PICKER_ICON_BUTTON_CLASS_NAME, showFavorites && "bg-[var(--color-background-button-secondary)] text-[var(--color-accent-yellow)] hover:text-[var(--color-accent-yellow)]")}
                  />
                }
              >
                {showFavorites ? <StarFilledIcon className="size-3.5" /> : <StarIcon className="size-3.5" />}
              </TooltipTrigger>
              <TooltipPopup side="top" sideOffset={6} variant="picker">{showFavorites ? "Show all models" : "Show favorites"}</TooltipPopup>
            </Tooltip>
            {canReload && (
              <Tooltip>
                <TooltipTrigger render={<button type="button" aria-label="Reload models" disabled={loading} onClick={onReload} className={PICKER_ICON_BUTTON_CLASS_NAME} />}>
                  {loading ? <Spinner size={12} /> : <RefreshCwIcon className="size-3.5" />}
                </TooltipTrigger>
                <TooltipPopup side="top" sideOffset={6} variant="picker">{loading ? "Reloading models…" : "Reload models"}</TooltipPopup>
              </Tooltip>
            )}
          </div>
        )}
      </div>

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
                    selected={isSelected(row)}
                    favorite={row.kind === "model" && isFavorite(favorites, row.harness, row.model.id)}
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

      {canPickModel && efforts.length > 1 && (
        <>
          <div aria-hidden className={PICKER_DIVIDER_CLASS_NAME} />
          <EffortSlider
            efforts={efforts}
            value={effortValue}
            defaultEffort={current?.default_effort ?? null}
            disabled={busy}
            onChange={onEffortChange}
          />
        </>
      )}
    </>
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
  defaultEffort,
  disabled,
  onChange,
}: {
  efforts: string[]
  value: string | null
  defaultEffort: string | null
  disabled: boolean
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
    <div className={cn("px-3 pb-3 pt-2.5 transition-opacity duration-150", disabled && "opacity-60")}>
      <div className="mb-2 flex items-baseline justify-between gap-2 text-[length:var(--app-font-size-ui-sm,11px)]">
        <span className="text-muted-foreground/50">Effort</span>
        <TextSwap
          text={formatEffort(label)}
          render={(text) => (
            <>
              <span className="font-medium text-[var(--effort-accent)]">{text}</span>
              {defaultEffort && text === formatEffort(defaultEffort) && <span className="text-muted-foreground/50"> · Default</span>}
            </>
          )}
          className="[--effort-accent:oklch(0.62_0.1_255)] dark:[--effort-accent:oklch(0.76_0.08_255)]"
        />
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={live}
        aria-valuetext={label === defaultEffort ? `${formatEffort(label)}, default` : formatEffort(label)}
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
