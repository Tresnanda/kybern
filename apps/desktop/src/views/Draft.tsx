// Home / new-thread landing, as Synara's centered empty landing: logo, the
// "What should we do in {project}?" heading with a dotted project picker, and
// the composer anchored at the bottom with its controls tray.

import { useEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"

import { Logo } from "@/components/kybern/bits"
import { ComposerPickerMenuPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@/components/synara/menu"
import { useLocalStorage } from "@/lib/hooks"
import { CheckIcon, DeviceLaptopIcon, FolderIcon, GitBranchIcon, WorktreeIcon } from "@/lib/synara/icons"
import { cn } from "@/lib/utils"
import type { PermissionMode, ProjectId, ProviderInstance } from "@/protocol"
import { createThread } from "@/state/rpc"
import { selectAvailableProviders, useStore } from "@/state/store"

import { Composer, LandingTray, TrayChip, type ComposerHandle, type SlashCommand } from "./Composer"
import { CHAT_COLUMN_GUTTER } from "./chatLayout"
import { SurfaceHeader } from "./chrome"

export function Draft({ projectId }: { projectId: ProjectId }) {
  const project = useStore((s) => s.projects[projectId])
  const projects = useStore((s) => s.projects)
  const settings = useStore((s) => s.settings)
  const allProviders = useStore((s) => s.providers)
  const providers = useStore(useShallow(selectAvailableProviders))
  const set = useStore((s) => s.set)
  const composer = useRef<ComposerHandle>(null)

  const [modeStored, setMode] = useLocalStorage<PermissionMode | null>("kybern.mode", null)
  const [providerStored, setProvider] = useLocalStorage<ProviderInstance | null>("kybern.provider", null)
  const [modelStored, setModelStored] = useLocalStorage<Record<string, { model?: string; effort?: string }>>("kybern.models", {})
  const [worktree, setWorktree] = useState<boolean | null>(null)

  const mode = modeStored ?? settings?.default_permission_mode ?? "supervised"
  const provider = useMemo<ProviderInstance | null>(() => {
    if (providerStored && providers.some((p) => p.kind === providerStored.kind)) return providerStored
    const def = settings?.default_provider
    const pick = providers.find((p) => p.kind === def) ?? providers[0]
    return pick ? { kind: pick.kind, instance: "default" } : null
  }, [providerStored, providers, settings])
  const choice = provider ? modelStored[provider.kind] : undefined
  const useWorktree = worktree ?? project?.worktrees_default ?? settings?.worktrees_default ?? false

  useEffect(() => {
    composer.current?.focus()
  }, [projectId])

  const commands = useMemo<SlashCommand[]>(
    () => [
      { name: "attach", hint: "Attach files or images", run: () => document.querySelector<HTMLInputElement>('input[type="file"]')?.click() },
      { name: "settings", hint: "Open settings", run: () => set({ settingsOpen: true, settingsTab: "general" }) },
      { name: "usage", hint: "Token usage and cost", run: () => set({ settingsOpen: true, settingsTab: "usage" }) },
    ],
    [set],
  )

  if (!project) return null
  const projectList = Object.values(projects).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SurfaceHeader minimal />
      <div className={cn("chat-pane-enter flex min-h-0 flex-1 flex-col", CHAT_COLUMN_GUTTER)}>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-4 px-6 text-center select-none mx-auto w-full min-w-0 max-w-[var(--app-chat-max-width,46rem)]">
            <Logo size={40} className="text-foreground" />
            <h2 className="text-[26px] font-normal leading-[1.15] tracking-[-0.015em] text-foreground/95 sm:text-[30px]">
              What should we do in{" "}
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      className="cursor-pointer rounded-sm text-inherit underline decoration-dotted decoration-[1.5px] underline-offset-[6px] transition-colors duration-150 ease-out hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
                    />
                  }
                >
                  {project.name}
                </MenuTrigger>
                <ComposerPickerMenuPopup align="center" side="bottom" className="min-w-56">
                  <MenuGroup>
                    {projectList.map((p) => (
                      <MenuItem key={p.id} onClick={() => useStore.getState().selectDraft(p.id)}>
                        <FolderIcon />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {p.id === projectId && <CheckIcon className="size-3.5 shrink-0" />}
                      </MenuItem>
                    ))}
                  </MenuGroup>
                </ComposerPickerMenuPopup>
              </Menu>
              ?
            </h2>
          </div>
        </div>

        <div className="w-full shrink-0 pb-3 sm:pb-4">
          <Composer
            ref={composer}
            autoFocus
            mode={mode}
            onModeChange={setMode}
            provider={provider}
            onProviderChange={setProvider}
            providers={allProviders}
            model={choice?.model}
            effort={choice?.effort}
            onModelChange={(model, effort) => provider && setModelStored((m) => ({ ...m, [provider.kind]: { model, effort } }))}
            projectId={projectId}
            commands={commands}
            disabled={!provider}
            disabledReason="Install a coding agent first"
            above={
              <LandingTray>
                <TrayChip icon={<FolderIcon className="size-3.5 shrink-0" />}>{project.name}</TrayChip>
                <TrayChip icon={<DeviceLaptopIcon className="size-3.5 shrink-0" />}>Local</TrayChip>
                {project.is_git && (
                  <TrayChip
                    icon={useWorktree ? <WorktreeIcon className="size-3.5 shrink-0" /> : <GitBranchIcon className="size-3.5 shrink-0" />}
                    onClick={() => setWorktree(!useWorktree)}
                    className={cn(useWorktree && "text-[var(--color-text-foreground)]")}
                  >
                    {useWorktree ? "New worktree" : "Current branch"}
                  </TrayChip>
                )}
              </LandingTray>
            }
            onSend={async (message) => {
              if (!provider) return
              await createThread({ projectId, provider, permissionMode: mode, model: choice?.model, effort: choice?.effort, useWorktree, message })
            }}
          />
        </div>
      </div>
    </div>
  )
}
