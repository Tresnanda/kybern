// Home / new-thread landing: logo, the
// "What should we do in {project}?" heading with a dotted project picker, and
// the composer anchored at the bottom with its controls tray.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { useShallow } from "zustand/react/shallow"

import { Logo } from "@/components/kybern/bits"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/kit/menu"
import { COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { useLocalStorage } from "@/lib/hooks"
import { CheckIcon, ChevronDownIcon, ClockIcon, DeviceLaptopIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, MessageCircleIcon, PaperclipIcon, SettingsIcon, UsersIcon, WorktreeIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { PaneId } from "@/state/splitView"
import type { GitBranchesResult, PermissionMode, ProjectId, ProviderInstance } from "@/protocol"
import { activeRuntime, createThread, rpc } from "@/state/rpc"
import { selectAvailableProviders, useStore } from "@/state/store"
import { createProjectCoordinatorStarter, projectCoordinatorMode } from "../../../../packages/kybern-client/src/projectCoordinator"

import { Composer, LandingTray, type ComposerHandle, type SlashCommand } from "./Composer"
import { CHAT_COLUMN_GUTTER } from "./chatLayout"
import { SurfaceHeader } from "./chrome"
import { ProjectPicker } from "./ProjectPicker"

export function Draft({ projectId, paneId, onProjectChange, purpose = "thread" }: { projectId?: ProjectId; paneId?: PaneId; onProjectChange?: (id: ProjectId) => void; purpose?: "thread" | "coordinator" }) {
  const environmentId = useStore((s) => s.environmentId)
  const project = useStore((s) => projectId ? s.projects[projectId] : undefined)
  const projects = useStore((s) => s.projects)
  const settings = useStore((s) => s.settings)
  const allProviders = useStore((s) => s.providers)
  const providersLoading = useStore((s) => s.providersLoading)
  const providers = useStore(useShallow(selectAvailableProviders))
  const set = useStore((s) => s.set)
  const composer = useRef<ComposerHandle>(null)
  const coordinatorStarter = useRef<{
    runtime: ReturnType<typeof activeRuntime>
    controller: ReturnType<typeof createProjectCoordinatorStarter>
  } | null>(null)

  const [modeStored, setMode] = useLocalStorage<PermissionMode | null>(`kybern.mode:${environmentId}`, null)
  const [providerStored, setProvider] = useLocalStorage<ProviderInstance | null>(`kybern.provider:${environmentId}`, null)
  const [modelStored, setModelStored] = useLocalStorage<Record<string, { model?: string; effort?: string }>>(`kybern.models:${environmentId}`, {})
  const [worktree, setWorktree] = useState<boolean | null>(null)
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [branches, setBranches] = useState<GitBranchesResult | null>(null)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)

  const mode = modeStored ?? settings?.default_permission_mode ?? "supervised"
  const provider = useMemo<ProviderInstance | null>(() => {
    if (providerStored && providers.some((p) => p.kind === providerStored.kind)) return providerStored
    const def = settings?.default_provider
    const pick = providers.find((p) => p.kind === def) ?? providers[0]
    return pick ? { kind: pick.kind, instance: "default" } : null
  }, [providerStored, providers, settings])
  const choice = provider ? modelStored[provider.kind] : undefined
  const freeChat = !projectId
  const useWorktree = freeChat ? false : worktree ?? project?.worktrees_default ?? settings?.worktrees_default ?? false
  const coordinatorDraft = purpose === "coordinator"
  const providerStatus = provider ? providers.find((item) => item.kind === provider.kind) : undefined
  const dedicatedCoordinator = provider ? projectCoordinatorMode(provider.kind) === "dedicated" : false

  useEffect(() => {
    composer.current?.focus()
  }, [projectId])

  const isGit = project?.is_git ?? false
  const loadBranches = useCallback(() => {
    if (!isGit || !projectId) return
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
      { name: "resume", hint: "Continue a saved session", icon: <ClockIcon className="size-4" />, run: () => set({ sessionsOpen: true, sessionsProjectId: projectId ?? null }) },
      { name: "sessions", hint: "Browse saved sessions", icon: <ClockIcon className="size-4" />, run: () => set({ sessionsOpen: true, sessionsProjectId: projectId ?? null }) },
      { name: "attach", hint: "Attach files or images", icon: <PaperclipIcon className="size-4" />, run: () => document.querySelector<HTMLInputElement>('input[type="file"]')?.click() },
      { name: "settings", hint: "Open settings", icon: <SettingsIcon className="size-4" />, run: () => set({ settingsOpen: true, settingsTab: "general" }) },
      { name: "usage", hint: "Review token usage and cost", icon: <ClockIcon className="size-4" />, run: () => set({ settingsOpen: true, settingsTab: "usage" }) },
    ],
    [set, projectId],
  )

  if (!freeChat && !project) return null
  const projectList = Object.values(projects).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-1 flex-col">
      <SurfaceHeader minimal showSidebarControls={!paneId} />
      <div className={cn("chat-pane-enter flex min-h-0 flex-1 flex-col", CHAT_COLUMN_GUTTER)}>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="t-stagger flex flex-col items-center gap-4 px-6 text-center select-none mx-auto w-full min-w-0 max-w-[var(--app-chat-max-width,46rem)]">
            <Logo size={40} className="text-foreground" />
            <h2 style={{ "--i": 1 } as CSSProperties} className="text-[26px] font-normal leading-[1.15] tracking-[-0.015em] text-foreground/95 sm:text-[30px]">
              {freeChat ? "What can I help with?" : <>
              {coordinatorDraft ? "What should we work on in" : "What should we do in"}{" "}
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      className="cursor-pointer rounded-sm text-inherit underline decoration-dotted decoration-[1.5px] underline-offset-[6px] transition-colors duration-150 ease-out hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
                    />
                  }
                >
                  {project!.name}
                </MenuTrigger>
                <ComposerPickerMenuPopup align="center" side="bottom" className="min-w-56">
                  <MenuGroup>
                    {projectList.map((p) => (
                      <MenuItem key={p.id} onClick={() => onProjectChange ? onProjectChange(p.id) : useStore.getState().selectDraft(p.id, coordinatorDraft ? "coordinator" : "thread")}>
                        <FolderIcon />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {p.id === projectId && <CheckIcon className="size-3.5 shrink-0" />}
                      </MenuItem>
                    ))}
                  </MenuGroup>
                </ComposerPickerMenuPopup>
              </Menu>
              ?</>}
            </h2>
            {coordinatorDraft && (
              <p style={{ "--i": 2 } as CSSProperties} className="max-w-[58ch] text-pretty text-[length:var(--app-font-size-ui,12px)] leading-relaxed text-muted-foreground/75">
                On your first Send, the coordinator researches this project and saves what it learns, then plans and delegates your work. Later tasks reuse that knowledge.
              </p>
            )}
          </div>
        </div>

        <div className="t-stagger w-full shrink-0 pb-3 sm:pb-4">
          <div style={{ "--i": coordinatorDraft ? 3 : 2 } as CSSProperties}>
          <Composer
            surfaceMode={paneId ? "split" : "single"}
            draftKey={freeChat ? `free:${paneId ?? "main"}` : `${coordinatorDraft ? "coordinator" : "project"}:${projectId}:${paneId ?? "main"}`}
            ref={composer}
            autoFocus
            mode={mode}
            onModeChange={setMode}
            provider={provider}
            onProviderChange={(next) => {
              setProvider(next)
              const nextStatus = providers.find((item) => item.kind === next.kind)
              if (nextStatus && !nextStatus.supported_permission_modes.includes(mode)) {
                setMode(nextStatus.supported_permission_modes.includes("supervised") ? "supervised" : nextStatus.supported_permission_modes[0] ?? mode)
              }
            }}
            providers={allProviders}
            model={choice?.model}
            effort={choice?.effort}
            onModelChange={(model, effort) => { if (provider) setModelStored((m) => ({ ...m, [provider.kind]: { model, effort } })) }}
            projectId={projectId}
            placeholder={coordinatorDraft ? "Describe the outcome, constraints, and what success looks like" : undefined}
            commands={commands}
            sendDisabled={!provider}
            disabledReason={providersLoading ? "Checking installed coding agents…" : "Install a coding agent first"}
            above={
              <LandingTray>
                {coordinatorDraft && (
                  <span
                    title={dedicatedCoordinator ? "This harness enforces a coordination-only role." : "This harness keeps its native coding tools, so the coordination-only role is advisory."}
                    className={cn(TRAY_CHIP_CLASS_NAME, "cursor-default text-[var(--color-text-foreground)]")}
                  >
                    <UsersIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">Project coordinator</span>
                  </span>
                )}
                {freeChat ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <button
                          type="button"
                          aria-label="Choose a project"
                          className={cn(
                            TRAY_CHIP_CLASS_NAME,
                            "text-[var(--color-text-foreground)] transition-[color,background-color,scale] active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100",
                          )}
                        />
                      }
                    >
                      <MessageCircleIcon className="size-3.5 shrink-0" />
                      <span className="truncate whitespace-nowrap">Free chat</span>
                      <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
                    </MenuTrigger>
                    <ComposerPickerMenuPopup align="start" side="top" sideOffset={8} className="min-w-64">
                      <MenuGroup>
                        <MenuGroupLabel>Chat location</MenuGroupLabel>
                        <MenuRadioGroup
                          value="free"
                          onValueChange={(value) => {
                            if (value !== "free") useStore.getState().selectDraft(value)
                          }}
                        >
                          <MenuRadioItem value="free">
                            <MessageCircleIcon className="size-3.5" />
                            <span className="min-w-0 flex-1 truncate">Free chat</span>
                          </MenuRadioItem>
                          {projectList.map((p) => (
                            <MenuRadioItem key={p.id} value={p.id}>
                              <FolderIcon className="size-3.5" />
                              <span className="min-w-0 flex-1 truncate" title={p.name}>{p.name}</span>
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      </MenuGroup>
                      <MenuSeparator />
                      <MenuGroup>
                        <MenuItem className="w-full min-w-0 px-2.5" data-project-picker-add onClick={() => setProjectPickerOpen(true)}>
                          <span className="flex w-full min-w-0 items-center gap-2">
                            <FolderOpenIcon className="size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1 truncate">Add project…</span>
                          </span>
                        </MenuItem>
                      </MenuGroup>
                    </ComposerPickerMenuPopup>
                  </Menu>
                ) : <Menu>
                  <MenuTrigger render={<button type="button" aria-label="Switch project" className={TRAY_CHIP_CLASS_NAME} />}>
                    <FolderIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{project!.name}</span>
                    <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup align="start" side="top" sideOffset={8} className="min-w-56">
                    <MenuGroup>
                      <MenuGroupLabel>Project</MenuGroupLabel>
                      {projectList.map((p) => (
                        <MenuItem key={p.id} onClick={() => onProjectChange ? onProjectChange(p.id) : useStore.getState().selectDraft(p.id, coordinatorDraft ? "coordinator" : "thread")}>
                          <FolderIcon />
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          {p.id === projectId && <CheckIcon className="size-3.5 shrink-0" />}
                        </MenuItem>
                      ))}
                    </MenuGroup>
                  </ComposerPickerMenuPopup>
                </Menu>}

                {!freeChat && !coordinatorDraft && <Menu>
                  <MenuTrigger render={<button type="button" aria-label="Choose where the thread runs" className={cn(TRAY_CHIP_CLASS_NAME, useWorktree && "text-[var(--color-text-foreground)]")} />}>
                    {useWorktree ? <WorktreeIcon className="size-3.5 shrink-0" /> : <DeviceLaptopIcon className="size-3.5 shrink-0" />}
                    <span className="min-w-0 truncate">{useWorktree ? "New worktree" : "Checkout"}</span>
                    <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup align="start" side="top" sideOffset={8} className="w-64 min-w-64">
                    <MenuGroup>
                      <MenuGroupLabel>Run in</MenuGroupLabel>
                      <MenuRadioGroup value={useWorktree ? "worktree" : "local"} onValueChange={(v) => setWorktree(v === "worktree")}>
                        <MenuRadioItem value="local">
                          <DeviceLaptopIcon className="size-3.5" />
                          <span className="min-w-0 flex-1 truncate">Checkout</span>
                          <span className="shrink-0 text-muted-foreground/70">{parentPath(project!.path)}</span>
                        </MenuRadioItem>
                        <MenuRadioItem value="worktree" disabled={!isGit}>
                          <WorktreeIcon className="size-3.5" />
                          <span className="min-w-0 flex-1 truncate">New worktree</span>
                          {!isGit && <span className="shrink-0 text-muted-foreground/70">Needs git</span>}
                        </MenuRadioItem>
                      </MenuRadioGroup>
                    </MenuGroup>
                  </ComposerPickerMenuPopup>
                </Menu>}

                {!freeChat && !coordinatorDraft && isGit && (
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
              if (paneId) useStore.getState().focusSplitPane(paneId)
              if (!coordinatorDraft) {
                await createThread({ paneId, projectId, provider, permissionMode: mode, model: choice?.model, effort: choice?.effort, useWorktree, baseBranch: baseBranch ?? undefined, message })
                return
              }
              if (!projectId) throw new Error("Choose a project for the coordinator.")
              if (!providerStatus) throw new Error("Choose an available harness for the project coordinator.")
              const runtime = activeRuntime()
              if (!coordinatorStarter.current || coordinatorStarter.current.runtime !== runtime) {
                coordinatorStarter.current = {
                  runtime,
                  controller: createProjectCoordinatorStarter((method, params) => runtime.rpc().call(method, params), () => crypto.randomUUID()),
                }
              }
              const origin = coordinatorStarter.current
              const result = await origin.controller.send({
                projectId,
                provider: providerStatus,
                instance: provider.instance,
                permissionMode: mode,
                model: choice?.model,
                effort: choice?.effort,
              }, message)
              if (activeRuntime() !== origin.runtime) return
              useStore.getState().set((state) => ({ threads: { ...state.threads, [result.thread.id]: result.thread } }))
              useStore.getState().selectThread(result.thread.id)
              void origin.runtime.loadThread(result.thread.id)
            }}
          />
          </div>
        </div>
      </div>
      <ProjectPicker open={projectPickerOpen} onOpenChange={setProjectPickerOpen} />
    </div>
  )
}

/** Pressable tray chip: the toolbar picker capsule with a chevron, capped so long branch names truncate. */
const TRAY_CHIP_CLASS_NAME = cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "max-w-64 min-w-0 shrink")

function parentPath(p: string): string {
  const i = p.lastIndexOf("/")
  return i <= 0 ? p : "…/" + p.slice(p.slice(0, i).lastIndexOf("/") + 1, i)
}
