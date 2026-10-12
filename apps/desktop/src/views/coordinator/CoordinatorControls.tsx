// The Coordinator's settings controls, shared by the Project tab (a project's overrides)
// and Settings › Delegation (the global defaults): the autonomy and workspace segmented
// controls, the push switch, and one model chip per kind of work. A chip opens the
// composer's own model picker; its first row is "Use the default". Values and copy come
// from `packages/kybern-client/src/coordinatorSettings.ts`, which mobile shares.
import { useId, useState } from "react"

import { Button } from "@/components/kit/button"
import { Popover, PopoverClose, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/kit/popover"
import { SegmentedControl } from "@/components/kit/segmented-control"
import { Switch } from "@/components/kit/switch"
import { ModelPicker } from "@/components/kybern/ModelPicker"
import { ProviderMark } from "@/components/kybern/bits"
import { cn } from "@/lib/utils"
import type { CoordinatorRole, DelegationWorkspace, LeadAutonomy, ProviderInstance, RoleDefault } from "@/protocol"
import { useAccounts } from "@/state/accounts"
import { useStore } from "@/state/store"
import {
  AUTONOMY_OPTIONS,
  COORDINATOR_ROLES,
  COORDINATOR_SETTINGS_COPY,
  WORKSPACE_OPTIONS,
  autonomyHint,
  cleanRoleDefault,
  type RoleChip,
} from "../../../../../packages/kybern-client/src/coordinatorSettings"

/** A small label over a control, the dock's section-label size. */
export const COORDINATOR_FIELD_LABEL_CLASS = "mb-1.5 text-[length:var(--app-font-size-ui-sm,11px)] leading-4 text-muted-foreground/70"
/** The one-line explanation under a control. */
export const COORDINATOR_HINT_CLASS = "mt-1.5 text-[length:var(--app-font-size-ui-sm,11px)] leading-[1.4] text-pretty text-muted-foreground/65"

/** Equal segments across the full width; the kit control sizes to its labels otherwise. */
const FULL_WIDTH_SEGMENTS = "flex w-full [&>button]:min-w-0 [&>button]:flex-1 [&>button]:truncate"

export function AutonomyControl({ value, onChange, busy, labelledBy, fill = true }: { value: LeadAutonomy; onChange: (value: LeadAutonomy) => void; busy?: boolean; labelledBy?: string; fill?: boolean }) {
  return (
    <SegmentedControl
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : COORDINATOR_SETTINGS_COPY.autonomy}
      options={AUTONOMY_OPTIONS}
      value={value}
      busy={busy}
      onChange={(next) => onChange(next as LeadAutonomy)}
      className={cn(fill && FULL_WIDTH_SEGMENTS)}
    />
  )
}

export function WorkspaceControl({ value, onChange, busy, labelledBy, fill = true }: { value: DelegationWorkspace; onChange: (value: DelegationWorkspace) => void; busy?: boolean; labelledBy?: string; fill?: boolean }) {
  return (
    <SegmentedControl
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : COORDINATOR_SETTINGS_COPY.workspace}
      options={WORKSPACE_OPTIONS}
      value={value}
      busy={busy}
      onChange={(next) => onChange(next as DelegationWorkspace)}
      className={cn(fill && FULL_WIDTH_SEGMENTS)}
    />
  )
}

/** The autonomy control with its label and the hint for the chosen value. */
export function AutonomyField({ value, onChange, busy }: { value: LeadAutonomy; onChange: (value: LeadAutonomy) => void; busy?: boolean }) {
  const labelId = useId()
  const hintId = useId()
  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={hintId}>
      <p id={labelId} className={COORDINATOR_FIELD_LABEL_CLASS}>{COORDINATOR_SETTINGS_COPY.autonomy}</p>
      <AutonomyControl value={value} onChange={onChange} busy={busy} labelledBy={labelId} />
      <p id={hintId} className={COORDINATOR_HINT_CLASS} data-autonomy-hint={value}>{autonomyHint(value)}</p>
    </div>
  )
}

export function WorkspaceField({ value, onChange, busy }: { value: DelegationWorkspace; onChange: (value: DelegationWorkspace) => void; busy?: boolean }) {
  const labelId = useId()
  return (
    <div>
      <p id={labelId} className={COORDINATOR_FIELD_LABEL_CLASS}>{COORDINATOR_SETTINGS_COPY.workspace}</p>
      <WorkspaceControl value={value} onChange={onChange} busy={busy} labelledBy={labelId} />
    </div>
  )
}

/** "Push and open pull requests without asking", with what still asks under it. */
export function PushField({ checked, onChange, busy }: { checked: boolean; onChange: (value: boolean) => void; busy?: boolean }) {
  const titleId = useId()
  const detailId = useId()
  return (
    <div className="flex items-start gap-2.5">
      <div className="min-w-0 flex-1 cursor-default" onClick={() => !busy && onChange(!checked)}>
        <p id={titleId} className="text-[length:var(--app-font-size-ui,12px)] leading-[1.35] font-medium text-pretty text-foreground/90">{COORDINATOR_SETTINGS_COPY.push}</p>
        <p id={detailId} className="mt-0.5 text-[length:var(--app-font-size-ui-sm,11px)] leading-[1.4] text-pretty text-muted-foreground/65">{COORDINATOR_SETTINGS_COPY.pushDetail}</p>
      </div>
      <Switch className="mt-0.5" checked={checked} disabled={busy} onCheckedChange={onChange} aria-labelledby={titleId} aria-describedby={detailId} />
    </div>
  )
}

/**
 * The chip for one kind of work: the harness mark and model (and effort) when set, a
 * dashed "Default · …" or "Same as the Coordinator" when not. It opens the model picker.
 */
export function RoleModelChip({
  role,
  roleLabel,
  chip,
  value,
  fallbackProvider,
  defaultHint,
  onChange,
  busy,
}: {
  role: CoordinatorRole
  roleLabel: string
  chip: RoleChip
  /** What this scope itself sets for the role; null when it follows the default. */
  value: RoleDefault | null
  /** The harness the picker opens on when nothing is set (the Coordinator's own). */
  fallbackProvider: ProviderInstance
  /** What "Use the default" falls back to. */
  defaultHint: string
  onChange: (value: RoleDefault | null) => Promise<boolean>
  busy?: boolean
}) {
  const providers = useStore((s) => s.providers)
  const accounts = useAccounts()
  const provider: ProviderInstance = value?.provider ?? (chip.kind === "coordinator" ? null : chip.provider) ?? fallbackProvider
  const set = (next: RoleDefault | null) => onChange(cleanRoleDefault(next))
  const own = chip.kind === "set"
  return (
    <ModelPicker
      side="bottom"
      align="end"
      provider={provider}
      providers={providers}
      model={value?.model ?? null}
      effort={value?.effort ?? null}
      canPickModel
      canPickProvider
      canReload={false}
      loading={false}
      busy={!!busy}
      accounts={accounts}
      onReload={() => {}}
      defaultRow={{ title: COORDINATOR_SETTINGS_COPY.useDefault, hint: defaultHint }}
      onModelChange={(model, effort) => (model ? set({ provider, model, effort }) : set(null))}
      onEffortChange={(effort) => set({ provider, model: value?.model ?? null, effort })}
      onProviderChange={(next, choice) => set({ provider: next, model: choice?.model ?? null, effort: choice?.effort ?? null })}
      trigger={
        <Button
          type="button"
          size="xs"
          variant={own ? "subtle" : "chrome"}
          data-role-chip={role}
          data-role-chip-kind={chip.kind}
          aria-label={`${roleLabel} model: ${chip.label}. Change`}
          title={chip.label}
          className={cn(
            "ms-auto min-w-0 max-w-[62%] justify-start font-normal",
            !own && "border border-dashed border-[color:var(--color-border)] text-muted-foreground",
          )}
        >
          {chip.kind !== "coordinator" && chip.provider && <ProviderMark kind={chip.provider.kind} size={12} className={cn("size-3", !own && "opacity-70")} />}
          <span className="min-w-0 truncate">{chip.label}</span>
        </Button>
      }
    />
  )
}

/** One bordered list of the five kinds of work and their chips. */
export function RoleModelList({
  chips,
  values,
  fallbackProvider,
  defaultHint,
  onChange,
  busy,
}: {
  chips: Record<CoordinatorRole, RoleChip>
  values: Partial<Record<CoordinatorRole, RoleDefault | null>>
  fallbackProvider: ProviderInstance
  defaultHint: string
  onChange: (role: CoordinatorRole, value: RoleDefault | null) => Promise<boolean>
  busy?: boolean
}) {
  return (
    <ul className="divide-y divide-[color:var(--app-surface-divider)] overflow-hidden rounded-md border border-[color:var(--app-surface-divider)] bg-[var(--color-background-elevated-primary-opaque)]">
      {COORDINATOR_ROLES.map(({ role, label }) => (
        <li key={role} className="flex min-h-9 items-center gap-2 py-1 ps-2.5 pe-1.5" data-role-row={role}>
          <span className="min-w-0 shrink-0 text-[length:var(--app-font-size-ui,12px)] text-foreground/90">{label}</span>
          <RoleModelChip
            role={role}
            roleLabel={label}
            chip={chips[role]}
            value={cleanRoleDefault(values[role])}
            fallbackProvider={fallbackProvider}
            defaultHint={defaultHint}
            onChange={(value) => onChange(role, value)}
            busy={busy}
          />
        </li>
      ))}
    </ul>
  )
}

/**
 * A quiet text action that asks before it acts ("Redo setup", "Reset"): a small popover
 * with the consequence and two buttons, the action named in both places.
 */
export function ConfirmAction({
  label,
  title,
  detail,
  confirm,
  onConfirm,
  disabled,
  className,
}: {
  label: string
  title: string
  detail: string
  confirm: string
  onConfirm: () => void
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={disabled} className={className}>{label}</PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-64 font-system-ui">
        <div className="grid gap-1.5">
          <PopoverTitle className="text-[length:var(--app-font-size-ui,12px)] font-medium">{title}</PopoverTitle>
          <PopoverDescription className="text-[length:var(--app-font-size-ui-sm,11px)] leading-[1.45] text-pretty">{detail}</PopoverDescription>
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <PopoverClose render={<Button type="button" size="sm" variant="ghost" />}>Cancel</PopoverClose>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
            >
              {confirm}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  )
}
