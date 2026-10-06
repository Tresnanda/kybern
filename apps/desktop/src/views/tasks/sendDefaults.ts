// Where a task's run starts by default: the agent, model, effort, permission and
// workspace last used for that project, else the app's settings.
import { useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"

import { PROVIDER_LABEL } from "@/lib/format"
import type { PermissionMode, Project, ProjectId, ProviderInstance, ProviderModel, ProviderStatus, Settings } from "@/protocol"
import { readSendPrefs, type SendPrefs } from "@/state/tasks"
import { selectAvailableProviders, useStore } from "@/state/store"
import { findModel } from "../../../../../packages/kybern-client/src/models"

export interface SendConfig {
  provider: ProviderInstance | null
  status: ProviderStatus | undefined
  model: string | null
  modelInfo: ProviderModel | undefined
  effort: string | null
  permissionMode: PermissionMode
  useWorktree: boolean
  baseBranch: string | null
}

export function resolveSendConfig(input: {
  prefs: SendPrefs
  providers: ProviderStatus[]
  settings: Settings | null
  project: Project | undefined
}): SendConfig {
  const { prefs, providers, settings, project } = input
  const stored = prefs.provider && providers.some((item) => item.kind === prefs.provider!.kind) ? prefs.provider : null
  const fallback = providers.find((item) => item.kind === settings?.default_provider) ?? providers[0]
  const provider: ProviderInstance | null = stored ?? (fallback ? { kind: fallback.kind, instance: "default" } : null)
  const status = provider ? providers.find((item) => item.kind === provider.kind) : undefined
  const models = status?.models ?? []
  const sameAgent = !!stored
  const model = sameAgent && prefs.model ? prefs.model : null
  const modelInfo = model ? findModel(models, model) : models.find((item) => item.is_default)
  const effort = sameAgent && prefs.effort ? prefs.effort : null
  const preferredMode = prefs.permissionMode ?? settings?.default_permission_mode ?? "supervised"
  const modes = status?.supported_permission_modes ?? []
  const permissionMode = modes.length && !modes.includes(preferredMode) ? modes[0]! : preferredMode
  const isGit = project?.is_git ?? false
  return {
    provider,
    status,
    model,
    modelInfo,
    effort,
    permissionMode,
    // A git project runs in a new worktree unless you chose otherwise there.
    useWorktree: isGit ? prefs.useWorktree ?? true : false,
    baseBranch: prefs.baseBranch ?? null,
  }
}

export function useSendDefaults(projectId: ProjectId | null, version = 0): SendConfig {
  const providers = useStore(useShallow(selectAvailableProviders))
  const settings = useStore((s) => s.settings)
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  return useMemo(
    () => resolveSendConfig({ prefs: readSendPrefs(projectId), providers, settings, project }),
    // `version` re-reads the stored defaults after they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, providers, settings, project, version],
  )
}

/**
 * The send settings a run composer shows: the project's defaults with whatever the
 * person changed on top. Changing the project starts over (`reset`).
 */
export function useSendPicker(projectId: ProjectId | null) {
  const available = useStore(useShallow(selectAvailableProviders))
  const defaults = useSendDefaults(projectId)
  const [picked, setPicked] = useState<Partial<SendConfig>>({})
  const config: SendConfig = { ...defaults, ...picked }
  const pick = (patch: Partial<SendConfig>) => setPicked((current) => ({ ...current, ...patch }))
  const chooseProvider = (provider: ProviderInstance, choice?: { model?: string; effort?: string }) => {
    const status = available.find((item) => item.kind === provider.kind)
    const models = status?.models ?? []
    const modes = status?.supported_permission_modes ?? []
    const model = choice?.model ?? null
    setPicked((current) => {
      const mode = current.permissionMode ?? defaults.permissionMode
      return {
        ...current,
        provider,
        status,
        model,
        modelInfo: model ? findModel(models, model) : models.find((item) => item.is_default),
        effort: choice?.effort ?? null,
        permissionMode: modes.length && !modes.includes(mode) ? modes[0]! : mode,
      }
    })
  }
  const chooseModel = (model: string | undefined, effort: string | undefined) => {
    const models = config.status?.models ?? []
    pick({ model: model ?? null, modelInfo: model ? findModel(models, model) : models.find((item) => item.is_default), effort: effort ?? null })
  }
  return { config, pick, chooseProvider, chooseModel, reset: () => setPicked({}) }
}

export function agentLabel(config: Pick<SendConfig, "provider">): string {
  return config.provider ? PROVIDER_LABEL[config.provider.kind] : "No agent available"
}

/** The model's name without the agent's brand ("Claude Opus 4.8" next to Claude Code reads "Opus 4.8"). */
export function modelLabel(config: Pick<SendConfig, "model" | "modelInfo" | "provider">): string | null {
  const name = config.modelInfo?.display_name ?? config.model ?? null
  if (!name) return null
  return config.provider?.kind === "claude-code" ? name.replace(/^Claude\s+/i, "") : name
}

export function workspaceLabel(config: Pick<SendConfig, "useWorktree" | "baseBranch">, isGit: boolean, currentBranch?: string | null): string {
  if (!isGit) return "Project folder"
  if (!config.useWorktree) return "Local checkout"
  const base = config.baseBranch ?? currentBranch
  return base ? `New worktree from ${base}` : "New worktree"
}
