// Home / new-thread landing, as Synara's centered empty landing: logo, the
// "What should we do in {project}?" heading with a dotted project picker, and
// the composer anchored at the bottom with its controls tray.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"

import { Logo } from "@/components/kybern/bits"
import { ComposerPickerMenuPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/synara/menu"
import { COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "@/components/synara/chat/composerPickerStyles"
import { useLocalStorage } from "@/lib/hooks"
import { CheckIcon, ChevronDownIcon, DeviceLaptopIcon, FolderIcon, GitBranchIcon, WorktreeIcon } from "@/lib/synara/icons"
import { cn } from "@/lib/utils"
import type { GitBranchesResult, PermissionMode, ProjectId, ProviderInstance } from "@/protocol"
import { createThread, rpc } from "@/state/rpc"
import { selectAvailableProviders, useStore } from "@/state/store"

import { Composer, LandingTray, type ComposerHandle, type SlashCommand } from "./Composer"
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
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [branches, setBranches] = useState<GitBranchesResult | null>(null)

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

  const isGit = project?.is_git ?? false
  const loadBranches = useCallback(() => {
    if (!isGit) return
    rpc()
      .call("git.branches", { project_id: projectId })
      .then(setBranches)
      .catch(() => setBranches({ current: null, branches: [] }))
  }, [projectId, isGit])

  // Draft is keyed by project in App, so branch state resets with the project.
  useEffect(() => {
    loadBranches()
  }, [loadBranches])

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
                <Menu>
                  <MenuTrigger render={<button type="button" aria-label="Switch project" className={TRAY_CHIP_CLASS_NAME} />}>
                    <FolderIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{project.name}</span>
                    <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup align="start" side="top" sideOffset={8} className="min-w-56">
                    <MenuGroup>
                      <MenuGroupLabel>Project</MenuGroupLabel>
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

                <Menu>
                  <MenuTrigger render={<button type="button" aria-label="Choose where the thread runs" className={cn(TRAY_CHIP_CLASS_NAME, useWorktree && "text-[var(--color-text-foreground)]")} />}>
                    {useWorktree ? <WorktreeIcon className="size-3.5 shrink-0" /> : <DeviceLaptopIcon className="size-3.5 shrink-0" />}
                    <span className="min-w-0 truncate">{useWorktree ? "New worktree" : "Local"}</span>
                    <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup align="start" side="top" sideOffset={8} className="w-64 min-w-64">
                    <MenuGroup>
                      <MenuGroupLabel>Run in</MenuGroupLabel>
                      <MenuRadioGroup value={useWorktree ? "worktree" : "local"} onValueChange={(v) => setWorktree(v === "worktree")}>
                        <MenuRadioItem value="local">
                          <DeviceLaptopIcon className="size-3.5" />
                          <span className="min-w-0 flex-1 truncate">Local</span>
                          <span className="shrink-0 text-muted-foreground/70">{parentPath(project.path)}</span>
                        </MenuRadioItem>
                        <MenuRadioItem value="worktree" disabled={!isGit}>
                          <WorktreeIcon className="size-3.5" />
                          <span className="min-w-0 flex-1 truncate">New worktree</span>
                          {!isGit && <span className="shrink-0 text-muted-foreground/70">Needs git</span>}
                        </MenuRadioItem>
                      </MenuRadioGroup>
                    </MenuGroup>
                  </ComposerPickerMenuPopup>
                </Menu>

                {isGit && (
                  <Menu onOpenChange={(open) => open && loadBranches()}>
                    <MenuTrigger render={<button type="button" aria-label="Choose a branch" className={cn(TRAY_CHIP_CLASS_NAME, baseBranch && "text-[var(--color-text-foreground)]")} />}>
                      <GitBranchIcon className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate">{baseBranch ?? branches?.current ?? "Current branch"}</span>
                      <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
                    </MenuTrigger>
                    <ComposerPickerMenuPopup align="start" side="top" sideOffset={8} className="w-72 min-w-72">
                      <MenuGroup>
                        <MenuGroupLabel>{useWorktree ? "Fork the worktree from" : "Branch"}</MenuGroupLabel>
                        {branches === null ? (
                          <MenuItem disabled>
                            <span className="text-muted-foreground">Loading branches…</span>
                          </MenuItem>
                        ) : branches.branches.length === 0 ? (
                          <MenuItem disabled>
                            <span className="text-muted-foreground">No branches yet. Make a first commit.</span>
                          </MenuItem>
                        ) : (
                          <MenuRadioGroup value={baseBranch ?? branches.current ?? ""} onValueChange={(v) => setBaseBranch(v === branches.current ? null : (v as string))}>
                            {branches.branches.map((b) => (
                              <MenuRadioItem key={b.name} value={b.name}>
                                <GitBranchIcon className="size-3.5" />
                                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                                {b.is_current && <span className="shrink-0 text-muted-foreground/70">current</span>}
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        )}
                      </MenuGroup>
                      <MenuSeparator />
                      <MenuGroup>
                        <MenuCheckboxItem checked={useWorktree} onCheckedChange={(checked) => setWorktree(checked)}>
                          <WorktreeIcon className="size-3.5" />
                          <span className="min-w-0 flex-1 truncate">Create a worktree from this branch</span>
                        </MenuCheckboxItem>
                      </MenuGroup>
                    </ComposerPickerMenuPopup>
                  </Menu>
                )}
              </LandingTray>
            }
            onSend={async (message) => {
              if (!provider) return
              await createThread({ projectId, provider, permissionMode: mode, model: choice?.model, effort: choice?.effort, useWorktree, baseBranch: baseBranch ?? undefined, message })
            }}
          />
        </div>
      </div>
    </div>
  )
}

/** Pressable tray chip: the toolbar picker capsule with a chevron, capped so long branch names truncate. */
const TRAY_CHIP_CLASS_NAME = cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "max-w-64 min-w-0 shrink")

function parentPath(p: string): string {
  const i = p.lastIndexOf("/")
  return i <= 0 ? p : "…/" + p.slice(p.slice(0, i).lastIndexOf("/") + 1, i)
}
