// The composer's agent / model / effort panel (`components/kybern/ModelPicker.tsx`,
// `ModelPickerTabs.tsx`, `ComposerModelTriggerLabel.tsx`): a 20rem panel that
// opens upward from the trigger with a tab per agent account, a search field,
// the model list (sections, favorites, recents, "Show more"), and the effort
// card of the selected model. The pure list logic comes from the shared
// `packages/kybern-client/src/models.ts` and the desktop's `lib/accountUi.ts`.
import { motion, useGpuix, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { followLine, nextTabIndex, pickerTabs, type PickerTab } from '@/lib/accountUi'
import { formatEffort, PROVIDER_LABEL } from '@/lib/format'
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
  type ModelSection,
} from '../../../../packages/kybern-client/src/models.ts'
import type {
  AccountSummary,
  ModelParameter,
  ProviderInstance,
  ProviderKind,
  ProviderModel,
  ProviderStatus,
} from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { FONT_UI } from '../theme.ts'
import { EASE_OUT, ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { Kbd } from '../kit/Kbd.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { useFooterFit } from './footerWidth.tsx'
import { G } from './glyphs.ts'
import { CheckMark, muted, PickerItem, PickerMenu, PopupLayer, popoverStyle } from './Menu.tsx'
import { DURATION, EASE, SPRING } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Dim, SwapOnChange } from './motion.tsx'
import { patch, useComposer } from './store.ts'

const SEARCH_RESULT_LIMIT = 150
const SECTION_STEP = 100
const PANEL_WIDTH = 320
/** Effort thumb diameter; the track runs the panel's inner width (320 − 2 border − 24 padding). */
const THUMB = 28
const TRACK = PANEL_WIDTH - 2 - 24
const ROW_RADIUS = 6.4

type Row =
  | { kind: 'default'; key: string }
  | { kind: 'model'; key: string; harness: ProviderKind; model: ProviderModel; showBackend: boolean }
  | { kind: 'more'; key: string; section: string; hidden: number }
  | { kind: 'custom'; key: string; id: string }

type Block = { key: string; label: string | null; icon?: ProviderKind; rows: Row[] }

export interface ModelPickerProps {
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
  onProviderChange: (provider: ProviderInstance, choice?: { model?: string; effort?: string; pinAccount?: boolean }) => Promise<boolean>
  accounts: AccountSummary[]
  accountFollowsDefaults?: boolean
  accountInstance?: string
  onAccountChange?: (instance: string | null) => Promise<boolean>
  onReload: () => void
  /** The trigger's label (`ComposerModelTriggerLabel`). */
  label: (color: string) => ReactNode
  /** The trigger's lead where the provider mark is not enough (the account dot over the mark); defaults to the mark. */
  lead?: ReactNode
}

export function ModelPicker(props: ModelPickerProps) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const [open, setOpen] = useState(false)
  const pressedWhileOpen = useRef(false)
  const dismissedByOutside = useRef(false)
  const triggerRef = useRef<PublicInstance | null>(null)
  const enabled = props.canPickModel || props.canPickProvider || props.canReload
  const fit = useFooterFit()
  const close = () => {
    setOpen(false)
    props.onOpenChange?.(false)
    if (triggerRef.current) renderer?.focusElement?.(triggerRef.current.id)
  }
  return (
    <div style={{ display: 'flex', position: 'relative', minWidth: 0, flexShrink: 1 }}>
      <div
        ref={(el) => {
          triggerRef.current = el
        }}
        testId="model-picker"
        tabIndex={0}
        onMouseDown={() => {
          pressedWhileOpen.current = open
        }}
        onClick={() => {
          if (!enabled) return
          if (dismissedByOutside.current) {
            dismissedByOutside.current = false
            return
          }
          if (pressedWhileOpen.current) {
            pressedWhileOpen.current = false
            close()
            return
          }
          setOpen(true)
          props.onOpenChange?.(true)
        }}
        style={{ display: 'flex', minWidth: 0, flexShrink: 1 }}
      >
        <PickerChip truncate open={open} disabled={!enabled} chevron={enabled && fit.model} {...(props.lead ? { lead: props.lead } : { mark: props.provider.kind })}>
          {props.label(t.text)}
        </PickerChip>
      </div>
      {open && (
        // The desktop popover's open (`ModelPicker.tsx:129`): 250 ms smooth-out fade from the trigger.
        <PopupLayer
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          testId="model-picker-panel"
          onMouseDownOutside={() => {
            dismissedByOutside.current = true
            queueMicrotask(() => {
              dismissedByOutside.current = false
            })
            close()
          }}
          style={{ ...popoverStyle(t), display: 'flex', flexDirection: 'column', width: PANEL_WIDTH }}
        >
          <ModelPickerPanel {...props} close={close} />
        </PopupLayer>
      )}
    </div>
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
  close,
}: ModelPickerProps & { close: () => void }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const inputRef = useRef<PublicInstance | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, number>>({})
  const [view, setView] = useState<'all' | 'favorites'>('all')
  const favorites = useComposer((d) => d.favorites)
  const recents = useComposer((d) => d.recents)
  const showFavorites = view === 'favorites'

  const status = providers.find((item) => item.kind === provider.kind)
  const catalog = useMemo(() => status?.models ?? [], [status?.models])
  const current = model ? findModel(catalog, model) : catalog.find((item) => item.is_default)
  const selectedId = model ? current?.id ?? model : ''
  const multiBackend = useMemo(() => catalogBackends(catalog).length > 1, [catalog])
  const large = catalog.length > MODEL_FLAT_LIMIT
  const agentName = status?.display_name ?? PROVIDER_LABEL[provider.kind]
  const effortValue = effort ?? selectorEffort(current, model) ?? current?.default_effort ?? null
  const results = useMemo(() => (query.trim() && !showFavorites ? searchModels(catalog, query) : []), [catalog, query, showFavorites])
  const instanceOf = (harness: ProviderKind) => (harness === provider.kind ? provider.instance : instances?.[harness] ?? 'default')

  const blocks = useMemo<Block[]>(() => {
    const modelRow = (section: string, item: ProviderModel, showBackend = false, harness: ProviderKind = provider.kind): Row => ({
      kind: 'model',
      key: `${section}:${harness}:${item.id}`,
      harness,
      model: item,
      showBackend,
    })
    const search = query.trim()
    if (showFavorites) {
      const out: Block[] = []
      for (const item of providers) {
        if (!item.available || (item.kind !== provider.kind && !canPickProvider)) continue
        const starred = favorites
          .filter((f) => f.kind === item.kind && (f.instance ?? 'default') === instanceOf(item.kind))
          .map((f) => item.models?.find((entry) => favoriteMatches(f, entry)) ?? { id: f.id, display_name: f.id })
          .filter((entry, index, list) => list.findIndex((other) => other.id === entry.id) === index)
        const shown = search ? searchModels(starred, search) : starred
        if (!shown.length) continue
        const backends = catalogBackends(item.models ?? []).length > 1
        out.push({ key: `favorites:${item.kind}`, label: item.display_name, icon: item.kind, rows: shown.map((entry) => modelRow('favorites', entry, backends, item.kind)) })
      }
      return out
    }
    if (search) {
      const shown = results.slice(0, SEARCH_RESULT_LIMIT)
      const out: Block[] = []
      if ('agent default'.includes(search.toLowerCase())) out.push({ key: 'default', label: null, rows: [{ kind: 'default', key: 'default' }] })
      const sections: ModelSection<ProviderModel>[] = multiBackend ? modelSections(shown) : [{ key: 'results', label: null, models: shown }]
      for (const section of sections) out.push({ key: section.key, label: section.label, rows: section.models.map((item) => modelRow(section.key, item)) })
      const custom = customModelId(search)
      if (custom && !catalog.some((item) => item.id === custom) && (!results.length || /[/:.@-]/.test(custom)))
        out.push({ key: 'custom', label: null, rows: [{ kind: 'custom', key: 'custom', id: custom }] })
      return out
    }
    const out: Block[] = [{ key: 'default', label: null, rows: [{ kind: 'default', key: 'default' }] }]
    if (model && !current) out[0]!.rows.push({ kind: 'custom', key: 'current-custom', id: model })
    const sections = modelSections(catalog)
    const grouped = sections.length > 1
    if (grouped) {
      const starred = catalog.filter((item) => isFavoriteModel(favorites, provider.kind, item, provider.instance))
      if (starred.length) out.push({ key: 'starred', label: 'Favorites', rows: starred.map((item) => modelRow('starred', item, multiBackend)) })
      const recent = (recents[`${provider.kind}:${provider.instance}`] ?? [])
        .map((id) => findModel(catalog, id))
        .filter((item): item is ProviderModel => !!item && !isFavoriteModel(favorites, provider.kind, item, provider.instance))
        .filter((item, index, list) => list.indexOf(item) === index)
      if (recent.length) out.push({ key: 'recent', label: 'Recent', rows: recent.map((item) => modelRow('recent', item, multiBackend)) })
    }
    for (const section of sections) {
      const limit = grouped && large ? expanded[section.key] ?? MODEL_SECTION_PREVIEW : section.models.length
      const rows: Row[] = section.models.slice(0, limit).map((item) => modelRow(section.key, item))
      const hidden = section.models.length - limit
      if (hidden > 0) rows.push({ kind: 'more', key: `${section.key}:more`, section: section.key, hidden })
      out.push({ key: section.key, label: section.label, rows })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPickProvider, catalog, current, expanded, favorites, large, model, multiBackend, provider.kind, provider.instance, providers, instances, query, recents, results, showFavorites])

  const isSelected = (row: Row) =>
    row.kind === 'default' ? !selectedId : row.kind === 'model' ? row.harness === provider.kind && row.model.id === selectedId : row.kind === 'custom' && row.id === selectedId
  const rows = useMemo(() => blocks.flatMap((block) => block.rows), [blocks])
  const selectedIndex = rows.findIndex(isSelected)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const activeRow = rows.find((row) => row.key === activeKey) ?? (query.trim() ? rows[0] : rows[selectedIndex] ?? rows[0])
  const shortcutRows = useMemo(() => rows.filter((row): row is Extract<Row, { kind: 'model' }> => row.kind === 'model').slice(0, 9), [rows])

  const star = (row: Row) => {
    if (row.kind !== 'model') return
    patch((d) => ({ favorites: toggleFavoriteModel(d.favorites, row.harness, row.model, instanceOf(row.harness)) }))
  }

  const pick = async (row: Row) => {
    if (busy) return
    if (row.kind === 'more') {
      setExpanded((value) => ({ ...value, [row.section]: (value[row.section] ?? MODEL_SECTION_PREVIEW) + SECTION_STEP }))
      return
    }
    if (row.kind === 'default') {
      if (await onModelChange('', undefined)) close()
      return
    }
    const held = row.kind === 'model' && row.harness === provider.kind && row.model.id === selectedId && model ? selectedVariant(row.model, model) : undefined
    const id = row.kind === 'model' ? held?.id ?? row.model.id : row.id
    const nextEfforts = held?.efforts?.length ? held.efforts : row.kind === 'model' ? row.model.efforts ?? [] : []
    const nextEffort =
      effortValue && nextEfforts.includes(effortValue) ? effortValue : held?.default_effort ?? (row.kind === 'model' ? row.model.default_effort ?? undefined : undefined)
    const harness = row.kind === 'model' ? row.harness : provider.kind
    const saved =
      harness === provider.kind
        ? await onModelChange(id, nextEffort)
        : await onProviderChange({ kind: harness, instance: instanceOf(harness) }, { model: id, effort: nextEffort })
    if (saved) {
      const key = `${harness}:${instanceOf(harness)}`
      patch((d) => ({ recents: { ...d.recents, [key]: rememberModel(d.recents[key] ?? [], row.kind === 'model' ? row.model.id : id) } }))
      close()
    }
  }

  const onKeyDown = (key: string, cmd: boolean) => {
    if (key === 'escape') {
      close()
      return
    }
    if (cmd && /^[1-9]$/.test(key)) {
      const row = shortcutRows[Number(key) - 1]
      if (row) void pick(row)
      return
    }
    if (!rows.length) return
    if (key === 'down' || key === 'up') {
      const step = key === 'down' ? 1 : -1
      const index = activeRow ? rows.indexOf(activeRow) : -1
      setActiveKey(rows[(index + step + rows.length) % rows.length]!.key)
    } else if (key === 'enter' && activeRow) {
      void pick(activeRow)
    } else if (key === 'd' && cmd && activeRow?.kind === 'model') {
      star(activeRow)
    }
  }

  const tabs = useMemo(
    () =>
      pickerTabs({
        agents: providers.map((item) => ({ kind: item.kind, display_name: item.display_name, available: item.available })),
        accounts,
        current: { kind: provider.kind, instance: accountInstance ?? provider.instance },
        canPickProvider,
        starredView: showFavorites,
      }),
    [accountInstance, accounts, canPickProvider, provider.kind, provider.instance, providers, showFavorites],
  )
  const follow = followLine({ accounts, current: { kind: provider.kind, instance: accountInstance ?? provider.instance }, followsDefaults: accountFollowsDefaults })

  const focusInput = () => {
    if (inputRef.current) renderer?.focusElement?.(inputRef.current.id)
  }
  const resetList = () => {
    setQuery('')
    setExpanded({})
    setActiveKey(null)
  }
  const selectAccountTab = async (tab: Extract<PickerTab, { type: 'account' }>) => {
    if (busy || tab.notSetUp || tab.needsSignIn || tab.disabled) return
    if (tab.kind === provider.kind) {
      setView('all')
      if (tab.instance !== (accountInstance ?? provider.instance) || (accountFollowsDefaults && tab.multi)) {
        resetList()
        if (onAccountChange) await onAccountChange(tab.instance)
        else await onProviderChange({ kind: tab.kind, instance: tab.instance }, { pinAccount: true })
      }
      focusInput()
      return
    }
    setView('all')
    resetList()
    await onProviderChange({ kind: tab.kind, instance: tab.instance }, tab.multi ? { pinAccount: true } : undefined)
    focusInput()
  }

  const divider = <div style={{ height: 1, marginLeft: 12, marginRight: 12, flexShrink: 0, backgroundColor: ink(t, 0.07) }} />
  const listHeight = Math.min(336, 0.5 * 820)

  return (
    <>
      <Tabs
        tabs={tabs}
        busy={busy}
        canReload={canPickModel && canReload}
        loading={loading}
        onStarred={() => {
          setView('favorites')
          setActiveKey(null)
          focusInput()
        }}
        onAccount={(tab) => void selectAccountTab(tab)}
        onReload={onReload}
      />
      {follow && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, paddingLeft: 12, paddingRight: 12 }}>
          <Label color={t.textSecondary} size={13} truncate>
            {follow.text}
          </Label>
          {follow.state === 'pinned' && (
            <>
              <div style={{ flexGrow: 1 }} />
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onAccountChange?.(null)}>{follow.action}</Button>
            </>
          )}
        </div>
      )}
      {canPickModel && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, flexShrink: 0 }}>
            <SearchField
              ref={(el: PublicInstance | null) => {
                inputRef.current = el
              }}
              testId="model-search"
              label={showFavorites ? 'Search favorites' : `Search ${agentName} models`}
              placeholder={showFavorites ? 'Search favorites' : `Search ${agentName} models`}
              autoFocus
              width="100%"
              value={query}
              onChange={(value) => {
                setQuery(value)
                setActiveKey(null)
              }}
              onKeyDown={(e) => onKeyDown(e.key ?? '', !!e.modifiers?.cmd)}
              // The input consumes Enter as its own submit action; it never reaches onKeyDown.
              onSubmit={() => onKeyDown('enter', false)}
            />
          </div>
          {divider}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              padding: 4,
              overflowY: 'scroll',
              ...(large && !showFavorites ? { height: listHeight } : { maxHeight: listHeight }),
            }}
          >
            {blocks.map((block) => (
              <div key={block.key} style={{ display: 'flex', flexDirection: 'column' }}>
                {block.label && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 8, paddingTop: 10, paddingBottom: 4 }}>
                    {block.icon && <ProviderMark kind={block.icon} size={11} />}
                    <Label color={muted(t, 0.5)} size={13} truncate>
                      {block.label}
                    </Label>
                  </div>
                )}
                {block.rows.map((row) => (
                  <ModelRow
                    key={row.key}
                    row={row}
                    agentName={agentName}
                    active={row === activeRow}
                    shortcut={row.kind === 'model' && shortcutRows.includes(row) ? shortcutRows.indexOf(row) + 1 : undefined}
                    selected={isSelected(row)}
                    favorite={row.kind === 'model' && isFavoriteModel(favorites, row.harness, row.model, instanceOf(row.harness))}
                    starOnHover={showFavorites}
                    onHover={() => setActiveKey(row.key)}
                    onPick={() => void pick(row)}
                    onStar={() => star(row)}
                  />
                ))}
              </div>
            ))}
            {showFavorites && !rows.length && (
              <div style={{ display: 'flex', justifyContent: 'center', paddingLeft: 24, paddingRight: 24, paddingTop: 28, paddingBottom: 28 }}>
                <Label color={muted(t, 0.7)} style={{ textAlign: 'center' }}>
                  {query.trim() ? `No favorites match “${query.trim()}”` : 'Star a model to keep it here, whichever agent it belongs to.'}
                </Label>
              </div>
            )}
            {!showFavorites && query.trim() && results.length === 0 && !blocks.some((b) => b.key === 'custom') && (
              <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 24, paddingBottom: 24 }}>
                <Label color={muted(t, 0.7)}>{`No models match “${query.trim()}”`}</Label>
              </div>
            )}
            {!showFavorites && results.length > SEARCH_RESULT_LIMIT && (
              <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, paddingBottom: 6 }}>
                <Label color={muted(t, 0.5)} size={13}>{`Showing ${SEARCH_RESULT_LIMIT} of ${results.length}. Add a word to narrow the list.`}</Label>
              </div>
            )}
            {!showFavorites && catalog.length === 0 && !query.trim() && (
              <div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 8 }}>
                <Label color={muted(t, 0.6)} size={13} lineHeight={17.875} style={{ flexShrink: 1, minWidth: 0 }}>
                  {loading ? 'Loading models…' : `${agentName} didn’t list any models. It uses its own setting until you reload or enter an ID.`}
                </Label>
              </div>
            )}
          </div>
          <ModelFooter
            current={current}
            model={model}
            effort={effort}
            onClose={close}
            fallbackEfforts={status?.supported_efforts}
            busy={busy}
            divider={divider}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
          />
        </>
      )}
    </>
  )
}

/** `ModelPickerTabs`: Starred, then one tab per agent account; reload at the end. */
function Tabs({
  tabs,
  busy,
  canReload,
  loading,
  onStarred,
  onAccount,
  onReload,
}: {
  tabs: PickerTab[]
  busy: boolean
  canReload: boolean
  loading: boolean
  onStarred: () => void
  onAccount: (tab: Extract<PickerTab, { type: 'account' }>) => void
  onReload: () => void
}) {
  const t = useTheme()
  const [hover, setHover] = useState<string | null>(null)
  const yellow = t.v('--color-accent-yellow')
  const renderer = useGpuixRequired()
  const nodes = useRef<(PublicInstance | null)[]>([])
  // Roving focus (`ModelPickerTabs`): ←/→ move between enabled tabs, Home/End jump, Enter or Space activates.
  const move = (key: string, index: number) => {
    const target = key === 'right' ? nextTabIndex(tabs, index, 1) : key === 'left' ? nextTabIndex(tabs, index, -1) : key === 'home' ? nextTabIndex(tabs, -1, 1) : key === 'end' ? nextTabIndex(tabs, tabs.length, -1) : -1
    const node = target >= 0 ? nodes.current[target] : null
    if (node) renderer.focusElement?.(node.id)
    return !!node
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingLeft: 6, paddingRight: 6, paddingTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, paddingBottom: 4, flexGrow: 1 }}>
        {tabs.map((tab, tabPosition) => {
          const hovered = hover === tab.key
          const dim = tab.type === 'starred' ? 0.45 : tab.needsSignIn ? 0.3 : tab.notSetUp || tab.disabled ? 0.2 : busy && !tab.selected ? 0.2 : 0.45
          const hoverDim = tab.type === 'starred' ? 1 : tab.needsSignIn || tab.notSetUp ? 0.6 : tab.disabled || busy ? dim : 1
          const opacity = tab.selected ? 1 : hovered ? hoverDim : dim
          const fill = tab.selected ? t.buttonSecondary : hovered && !(tab.type === 'account' && tab.disabled) ? t.buttonSecondaryHover : undefined
          return (
            <div
              key={tab.key}
              testId={`model-tab-${tab.key}`}
              ref={node => { nodes.current[tabPosition] = node }}
              role="tab"
              aria-selected={tab.selected}
              tabIndex={tab.selected ? 0 : -1}
              onKeyDown={e => {
                if (e.key === 'enter' || e.key === 'space') { if (tab.type === 'starred') onStarred(); else if (!tab.disabled) onAccount(tab); return }
                move(e.key ?? '', tabPosition)
              }}
              onMouseEnter={() => setHover(tab.key)}
              onMouseLeave={() => setHover((h) => (h === tab.key ? null : h))}
              onClick={() => (tab.type === 'starred' ? onStarred() : onAccount(tab))}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                height: 28,
                minWidth: 28,
                paddingLeft: 6,
                paddingRight: 6,
                borderRadius: ROW_RADIUS,
                flexShrink: 0,
                opacity,
                cursor: 'pointer',
                ...(fill ? { backgroundColor: fill } : {}),
              }}
            >
              {tab.type === 'starred' ? (
                <Icon source={tab.selected ? G.starFilled : G.star} size={14} color={tab.selected ? yellow : t.textSecondary} />
              ) : (
                <>
                  <ProviderMark kind={tab.kind} size={14} />
                  {tab.label && (
                    <Label color={t.text} size={13} truncate>
                      {tab.label}
                    </Label>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
      {canReload && (
        <div
          testId="model-reload"
          onMouseEnter={() => setHover('__reload')}
          onMouseLeave={() => setHover((h) => (h === '__reload' ? null : h))}
          onClick={() => !loading && onReload()}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            marginBottom: 4,
            borderRadius: ROW_RADIUS,
            flexShrink: 0,
            cursor: 'pointer',
            ...(hover === '__reload' && !loading ? { backgroundColor: t.buttonSecondaryHover } : {}),
          }}
        >
          {loading ? <MatrixLoader /> : <Icon source={G.refresh} size={14} color={hover === '__reload' ? t.text : muted(t, 0.6)} />}
        </div>
      )}
    </div>
  )
}

/** `PickerRow`: the selected model keeps a soft fill; the trailing edge holds ⌘N and the star. */
function ModelRow({
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
  row: Row
  agentName: string
  active: boolean
  shortcut?: number
  selected: boolean
  favorite: boolean
  starOnHover: boolean
  onHover: () => void
  onPick: () => void
  onStar: () => void
}) {
  const t = useTheme()
  const starClicked = useRef(false)
  const base = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    paddingLeft: 8,
    paddingRight: 8,
    borderRadius: ROW_RADIUS,
    cursor: 'default' as const,
    ...(selected ? { backgroundColor: t.buttonSecondary } : active ? { backgroundColor: t.buttonSecondaryHover } : {}),
  }
  if (row.kind === 'more') {
    return (
      <div onMouseMove={onHover} onClick={onPick} style={{ ...base, height: 28 }}>
        <Label color={muted(t, 0.6)} truncate>{`Show ${Math.min(row.hidden, SECTION_STEP)} more`}</Label>
      </div>
    )
  }
  let title: string
  let detail: string | null = null
  let description: string | null = null
  if (row.kind === 'default') {
    title = 'Agent default'
    description = null
    void agentName
  } else if (row.kind === 'custom') {
    title = row.id
    detail = selected ? 'Custom ID' : 'Use as model ID'
  } else {
    title = row.model.display_name
    description = row.model.description ?? null
    detail = row.showBackend && row.model.provider ? backendLabel(row.model.provider) : null
  }
  return (
    <div
      testId={row.kind === 'model' ? `model-row-${row.model.id}` : `model-row-${row.kind}`}
      onMouseMove={() => !active && onHover()}
      onClick={() => {
        if (starClicked.current) {
          starClicked.current = false
          return
        }
        onPick()
      }}
      style={{ ...base, ...(description ? { minHeight: 38, paddingTop: 4, paddingBottom: 4 } : { height: 28 }) }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <Label color={t.text} lineHeight={18} truncate>
            {title}
          </Label>
          {detail && (
            <Label color={muted(t, 0.5)} size={13} style={{ flexShrink: 0 }}>
              {detail}
            </Label>
          )}
        </div>
        {description && (
          <Label color={muted(t, 0.5)} size={13} lineHeight={17} truncate>
            {description}
          </Label>
        )}
      </div>
      {shortcut && <Kbd keys={['⌘', String(shortcut)]} testId={`model-shortcut-${shortcut}`} />}
      {row.kind === 'model' && (
        <div
          onMouseDown={() => {
            starClicked.current = true
          }}
          onClick={() => onStar()}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            marginRight: -6,
            borderRadius: 4.8,
            flexShrink: 0,
            opacity: (favorite && !starOnHover) || active ? 1 : 0,
          }}
        >
          <Icon source={favorite ? G.starFilled : G.star} size={12} color={favorite ? t.v('--color-accent-yellow') : muted(t, 0.5)} />
        </div>
      )}
    </div>
  )
}

const isFastParameter = (parameter: ModelParameter) => !!parameterSwitch(parameter) && /fast|speed/i.test(`${parameter.id} ${parameter.label}`)

/** `oklch(0.62 0.1 255)` / `oklch(0.76 0.08 255)`: the effort label and bolt. */
const effortAccent = (dark: boolean) => (dark ? 'oklch(0.76 0.08 255)' : 'oklch(0.62 0.1 255)')
/** `--effort-fill`. */
const effortFill = (dark: boolean) => (dark ? 'oklch(0.72 0.085 255)' : 'oklch(0.68 0.1 255)')

/** `ModelFooter`: the effort card (bolt, label, reset, slider) and one row per other trait. */
function ModelFooter({
  current,
  model,
  effort,
  fallbackEfforts,
  busy,
  divider,
  onModelChange,
  onEffortChange,
  onClose,
}: {
  onClose: () => void
  current: ProviderModel | undefined
  model?: string | null
  effort?: string | null
  fallbackEfforts?: string[]
  busy: boolean
  divider: ReactNode
  onModelChange: (model: string, effort: string | undefined) => Promise<boolean>
  onEffortChange: (effort: string) => Promise<boolean>
}) {
  const t = useTheme()
  const variant = selectedVariant(current, model)
  const efforts = current ? (variant?.efforts?.length ? variant.efforts : current.efforts ?? []) : fallbackEfforts ?? []
  const defaultEffort = variant?.default_effort ?? current?.default_effort ?? null
  const effortValue = effort ?? selectorEffort(current, model) ?? defaultEffort
  const parameters = current?.parameters ?? []
  const traits = traitValues(current, model)
  const [pending, setPending] = useState<{ id: string; value: string; from: string | undefined } | null>(null)
  const shown = pending && pending.from === variant?.id ? { ...traits, [pending.id]: pending.value } : traits

  const change = async (parameter: string, value: string) => {
    if (!current || busy || traits[parameter] === value) return
    const next = changeTrait(current, model, parameter, value)
    if (!next) return
    const nextEfforts = next.efforts?.length ? next.efforts : current.efforts ?? []
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
  const dark = t.variant === 'dark'
  const resetButton =
    traitsChanged || effortChanged ? (
      <IconButton testId="effort-reset" size="sm" label="Reset to defaults" icon={G.reset} disabled={busy} onClick={() => void reset()} style={{ marginLeft: -2, marginRight: -2 }} />
    ) : null
  const fastButton =
    fast && fastToggle ? (
      <IconButton testId="fast-toggle" size="sm" label={fastOn ? 'Turn off fast mode' : 'Turn on fast mode'} icon={fastOn ? G.bolt : G.boltOutline} glyph={16} color={fastOn ? effortAccent(dark) : undefined} disabled={busy || !!fastReason} onClick={() => void change(fast.id, fastOn ? fastToggle.off : fastToggle.on)} style={{ marginLeft: -2, marginRight: -2 }} />
    ) : null

  if (!rows.length && !hasEffort && !fast) return null
  return (
    <>
      {divider}
      {hasEffort ? (
        <EffortSlider onEscape={onClose} efforts={efforts} value={effortValue} disabled={busy} leading={fastButton} trailing={resetButton} onChange={onEffortChange} />
      ) : fast ? (
        <Dim dimmed={busy} style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 4 }}>
          <CardHeader leading={fastButton} trailing={resetButton}>
            <Label color={fastOn ? effortAccent(dark) : muted(t, 0.6)} weight={500}>
              {fastOn ? 'Fast' : 'Standard'}
            </Label>
          </CardHeader>
        </Dim>
      ) : null}
      {rows.length > 0 && (
        <Dim dimmed={busy} style={{ paddingLeft: 4, paddingRight: 4, paddingBottom: 4, paddingTop: hasEffort || fast ? 2 : 4 }}>
          {rows.map((parameter) => (
            <TraitRow
              key={parameter.id}
              parameter={parameter}
              value={shown[parameter.id] ?? parameter.default}
              unavailable={(value) => (current ? traitUnavailableReason(current, model, parameter.id, value) : null)}
              onChange={(value) => void change(parameter.id, value)}
            />
          ))}
        </Dim>
      )}
      {!hasEffort && !fast && <div style={{ height: 2 }} />}
    </>
  )
}

/** Bolt on the left, state in the middle, reset on the right; each end a fixed 24px slot. */
function CardHeader({ leading, trailing, children }: { leading?: ReactNode; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, marginBottom: 6 }}>
      <div style={{ display: 'flex', width: 24, flexShrink: 0, justifyContent: 'flex-start' }}>{leading}</div>
      <div style={{ display: 'flex', flexGrow: 1, minWidth: 0, justifyContent: 'center' }}>{children}</div>
      <div style={{ display: 'flex', width: 24, flexShrink: 0, justifyContent: 'flex-end' }}>{trailing}</div>
    </div>
  )
}

/**
 * Effort as a stepped slider: one dot per level, the fill trails a 28px
 * thumb. A press moves the thumb to the nearest level, a drag follows the
 * pointer, release commits. Pointer moves glide on the ease-out (none under
 * Reduce Motion); keys move instantly.
 */
export function EffortSlider({
  efforts,
  value,
  disabled,
  leading,
  trailing,
  onChange,
  onEscape,
}: {
  onEscape: () => void
  efforts: string[]
  value: string | null
  disabled: boolean
  leading?: ReactNode
  trailing?: ReactNode
  onChange: (effort: string) => Promise<boolean>
}) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const track = useRef<PublicInstance | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  // Mouse down and up can arrive in one tick, before `drag` re-renders.
  const dragRef = useRef<number | null>(null)
  const [pending, setPending] = useState<{ effort: string; from: string | null } | null>(null)
  const [glide, setGlide] = useState(true)
  const shown = pending && pending.from === value ? pending.effort : value
  const max = efforts.length - 1
  const index = Math.max(0, efforts.indexOf(shown ?? ''))
  const at = drag ?? index / max
  const live = drag === null ? index : Math.round(drag * max)
  const label = efforts[live]!
  const dark = t.variant === 'dark'
  const span = TRACK - THUMB

  const ratio = (x: number | undefined) => {
    const bounds = track.current ? renderer?.getElementBounds?.(track.current.id) : null
    if (!bounds || x === undefined) return at
    return Math.min(1, Math.max(0, (x - bounds.x - THUMB / 2) / (bounds.width - THUMB)))
  }
  const commit = async (next: number) => {
    const effort = efforts[Math.min(max, Math.max(0, next))]!
    if (effort === shown) return
    setPending({ effort, from: value })
    if (!(await onChange(effort))) setPending(null)
  }
  // Dragging tracks the pointer in 70 ms; letting go settles onto the notch with the desktop's spring (`--ease-spring`).
  const transition = REDUCED_MOTION || !glide ? { duration: 0 } : drag === null ? SPRING : { duration: 0.07, ease: EASE_OUT }
  // The held thumb grows to 1.06 over 200 ms and a soft glow rises under it; letting go eases back in 150 ms.
  const held = drag !== null && PATCHED_NATIVE && !REDUCED_MOTION
  const ease = [...EASE.out] as [number, number, number, number]

  return (
    <Dim dimmed={disabled} style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10 }}>
      <CardHeader leading={leading} trailing={trailing}>
        {/* `TextSwap` on the level name (`ModelPicker.tsx:789`). */}
        <SwapOnChange active={label}>
          <Label color={effortAccent(dark)} weight={500}>
            {formatEffort(label)}
          </Label>
        </SwapOnChange>
      </CardHeader>
      <div
        ref={(el) => {
          track.current = el
        }}
        testId="effort-slider"
        tabIndex={disabled ? -1 : 0}
        onMouseDown={(e) => {
          if (disabled) return
          setGlide(true)
          dragRef.current = ratio(e.x)
          setDrag(dragRef.current)
        }}
        onMouseMove={(e) => {
          if (dragRef.current === null || e.pressedButton !== 0) return
          dragRef.current = ratio(e.x)
          setDrag(dragRef.current)
        }}
        onMouseUp={(e) => {
          if (dragRef.current === null) return
          const next = Math.round(ratio(e.x) * max)
          dragRef.current = null
          setDrag(null)
          void commit(next)
        }}
        onMouseLeave={() => {
          if (dragRef.current === null) return
          const next = Math.round(dragRef.current * max)
          dragRef.current = null
          setDrag(null)
          void commit(next)
        }}
        onKeyDown={(e) => {
          if (e.key === 'escape') { onEscape(); return }
          if (disabled) return
          const step = e.key === 'right' || e.key === 'up' ? 1 : e.key === 'left' || e.key === 'down' ? -1 : 0
          if (step || e.key === 'home' || e.key === 'end') {
            setGlide(false)
            void commit(e.key === 'home' ? 0 : e.key === 'end' ? max : index + step)
          }
        }}
        style={{ position: 'relative', height: 28, width: TRACK, cursor: disabled ? 'default' : drag !== null ? 'grabbing' : 'grab' }}
      >
        {/* The parts paint fills, which would take the press from the track. */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 2, height: 24, borderRadius: 12, backgroundColor: ink(t, 0.08), pointerEvents: 'none' }} />
        <motion.div
          initial={false}
          animate={{ width: THUMB + span * at }}
          transition={transition}
          style={{ position: 'absolute', left: 0, top: 2, height: 24, borderRadius: 12, backgroundColor: effortFill(dark), pointerEvents: 'none' }}
        />
        {efforts.map((item, i) => (
          <div
            key={item}
            style={{
              position: 'absolute',
              left: THUMB / 2 + (span * i) / max - 2,
              top: 12,
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: i / max <= at + 0.001 ? 'rgba(255, 255, 255, 0.65)' : ink(t, 0.22),
              pointerEvents: 'none',
            }}
          />
        ))}
        <motion.div
          initial={false}
          animate={{ left: span * at }}
          transition={transition}
          style={{ position: 'absolute', top: 0, width: THUMB, height: THUMB, pointerEvents: 'none' }}
        >
          <div
            paintTransform={PATCHED_NATIVE && !REDUCED_MOTION ? { initial: false, animate: { scale: held ? 1.06 : 1 }, transition: { duration: held ? 0.2 : DURATION.quick, ease } } : undefined}
            style={{ position: 'relative', width: THUMB, height: THUMB }}
          >
            <div
              paintTransform={PATCHED_NATIVE && !REDUCED_MOTION ? { initial: false, animate: { opacity: held ? 1 : 0 }, transition: { duration: held ? 0.2 : DURATION.quick, ease } } : undefined}
              style={{ position: 'absolute', left: 0, top: 0, width: THUMB, height: THUMB, borderRadius: THUMB / 2, boxShadow: { offsetX: 0, offsetY: 2, blurRadius: 8, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.28)' }, pointerEvents: 'none' }}
            />
            <div
              style={{
                width: THUMB,
                height: THUMB,
                borderRadius: THUMB / 2,
                backgroundColor: '#ffffff',
                boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 3, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.22)' },
                pointerEvents: 'none',
              }}
            />
          </div>
        </motion.div>
      </div>
    </Dim>
  )
}

/** One trait other than effort and fast mode: "Label  value >" opening its values. */
function TraitRow({
  parameter,
  value,
  unavailable,
  onChange,
}: {
  parameter: ModelParameter
  value: string
  unavailable: (value: string) => string | null
  onChange: (value: string) => void
}) {
  const t = useTheme()
  const labelOf = (item: string) => parameter.values.find((entry) => entry.value === item)?.label ?? item
  return (
    <PickerMenu
      side="top"
      align="end"
      rootStyle={{ width: '100%' }}
      trigger={(open) => (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            height: 32,
            width: '100%',
            minWidth: 0,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: ROW_RADIUS,
            ...(open ? { backgroundColor: t.buttonSecondaryHover } : {}),
            hover: { backgroundColor: t.buttonSecondaryHover },
          }}
        >
          <Label color={t.text}>{parameter.label}</Label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <Label color={muted(t, 0.7)} truncate>
              {labelOf(value)}
            </Label>
            <Icon name="chevronRight" size={12} color={muted(t, 0.7)} />
          </div>
        </div>
      )}
    >
      {parameter.values.map((entry) => {
        const reason = unavailable(entry.value)
        return (
          <PickerItem key={entry.value} id={entry.value} disabled={!!reason} onSelect={() => onChange(entry.value)}>
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
              <Label color={t.text} truncate>
                {entry.label}
              </Label>
              {reason && (
                <Label color={muted(t, 0.7)} size={13}>
                  {reason}
                </Label>
              )}
            </div>
            <CheckMark color={t.text} visible={entry.value === value} />
          </PickerItem>
        )
      })}
    </PickerMenu>
  )
}

// Desktop kit.css account palette (these static CSS tokens are not in buildThemeCssVariables).
const accountDots: Record<string, [string, string]> = { blue: ['#0169cc', '#3386d6'], green: ['#00a240', '#2fbf63'], purple: ['#751ed9', '#b06dff'], pink: ['#c2307a', '#e86aa6'], teal: ['#0f8f86', '#33bfb3'], amber: ['#d97706', '#f5b44a'] }

/** The trigger's lead for an account with a colour: the provider mark with the account's dot hung over it (undefined otherwise: `ModelPicker` then draws the plain mark). */
export function accountLead(kind: ProviderKind, account?: { name: string; color?: string | null } | null): ReactNode | undefined {
  const dot = account?.color ? accountDots[account.color] : undefined
  if (!dot) return undefined
  // The desktop hangs a 6px dot 4px back over the mark (`-ml-1 self-start mt-0.5`) and leaves a 2px slot. A
  // negative margin made the native intrinsic width drop ~36px and clipped the effort and chevron, so the dot is
  // absolutely placed inside a 22px box (mark 14 + gap 6 + slot 2) instead.
  return <AccountMark kind={kind} dot={dot} />
}

function AccountMark({ kind, dot }: { kind: ProviderKind; dot: [string, string] }) {
  const t = useTheme()
  return (
    <div style={{ position: 'relative', display: 'flex', width: 22, height: 14, flexShrink: 0, pointerEvents: 'none' }}>
      <ProviderMark kind={kind} size={14} />
      <div style={{ position: 'absolute', left: 16, top: 2, width: 6, height: 6, borderRadius: 3, backgroundColor: dot[t.variant === 'dark' ? 1 : 0] }} />
    </div>
  )
}

/** `ComposerModelTriggerLabel`: account, model, qualifier, bolt, effort, traits. The mark leads and the chevron trails, both drawn by the `PickerChip`. */
export function ModelTriggerLabel({
  account,
  model,
  qualifier,
  fast,
  effort,
  traits,
}: {
  account?: { name: string; color?: string | null } | null
  model: string
  qualifier: string | null
  fast: boolean
  effort: string | null
  traits: string[]
}) {
  const t = useTheme()
  const fit = useFooterFit()
  return (
    <div testId="model-label" style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
      {account && fit.labels && <Label color={t.textSecondary} lineHeight={16} style={{ maxWidth: 96, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{account.name}</Label>}
      {/* `min-w-0 truncate`: the name takes the shrinking, and goes below 360px. */}
      {fit.model && (
        <Label color={t.text} lineHeight={16} truncate>
          {model}
        </Label>
      )}
      {qualifier && fit.labels && (
        <Label color={t.textSecondary} lineHeight={16} style={{ flexShrink: 0 }}>
          {qualifier}
        </Label>
      )}
      {fast && <Icon source={G.bolt} size={14} color={t.text} />}
      {effort && fit.effort && (
        <Label color={t.textSecondary} lineHeight={16} style={{ flexShrink: 0 }}>
          {effort}
        </Label>
      )}
      {traits.length > 0 && fit.effort && (
        <Label color={t.textSecondary} lineHeight={16} style={{ flexShrink: 0 }}>
          {traits.join(' · ')}
        </Label>
      )}
    </div>
  )
}

