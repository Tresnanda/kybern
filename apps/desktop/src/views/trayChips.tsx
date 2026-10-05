// Chips for the tray stacked above a composer: the project a new thread or run
// starts in, where it runs (checkout or a new worktree) and the branch it starts
// from. Shared by the home screen (Draft) and a task's run composer.

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { COMPOSER_TRAY_CHIP_CLASS_NAME as TRAY_CHIP_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/kit/menu"
import { CheckIcon, ChevronDownIcon, DeviceLaptopIcon, FolderIcon, GitBranchIcon, WorktreeIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { GitBranchesResult, Project, ProjectId } from "@/protocol"

/** The project chip. `projectId` null shows `placeholder`. */
export function ProjectTrayChip({
  projectId,
  projects,
  onPick,
  placeholder = "Choose a project",
  label = "Switch project",
}: {
  projectId: ProjectId | null
  /** Sorted as they should be listed. */
  projects: readonly Project[]
  onPick: (id: ProjectId) => void
  placeholder?: string
  label?: string
}) {
  const current = projectId ? projects.find((item) => item.id === projectId) : undefined
  return (
    <Menu>
      <MenuTrigger render={<button type="button" aria-label={label} className={cn(TRAY_CHIP_CLASS_NAME, !current && "text-[var(--color-text-foreground)]")} />}>
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{current?.name ?? placeholder}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="top" sideOffset={8} className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Project</MenuGroupLabel>
          {projects.map((item) => (
            <MenuItem key={item.id} onClick={() => onPick(item.id)}>
              <FolderIcon />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.id === projectId && <CheckIcon className="size-3.5 shrink-0" />}
            </MenuItem>
          ))}
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

/** Checkout or a new worktree. `checkoutHint` names where the checkout lives. */
export function WorkspaceTrayChip({
  useWorktree,
  isGit,
  checkoutHint,
  onChange,
  label = "Choose where the thread runs",
}: {
  useWorktree: boolean
  isGit: boolean
  checkoutHint?: string
  onChange: (worktree: boolean) => void
  label?: string
}) {
  return (
    <Menu>
      <MenuTrigger render={<button type="button" aria-label={label} className={cn(TRAY_CHIP_CLASS_NAME, useWorktree && "text-[var(--color-text-foreground)]")} />}>
        {useWorktree ? <WorktreeIcon className="size-3.5 shrink-0" /> : <DeviceLaptopIcon className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{useWorktree ? "New worktree" : "Checkout"}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="top" sideOffset={8} className="w-64 min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Run in</MenuGroupLabel>
          <MenuRadioGroup value={useWorktree ? "worktree" : "local"} onValueChange={(value) => onChange(value === "worktree")}>
            <MenuRadioItem value="local">
              <DeviceLaptopIcon className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">Checkout</span>
              {checkoutHint && <span className="shrink-0 text-muted-foreground/70">{checkoutHint}</span>}
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
  )
}

/** The branch to start from; `baseBranch` null means the current branch. */
export function BranchTrayChip({
  branches,
  baseBranch,
  useWorktree,
  onOpen,
  onBranch,
  onWorktree,
}: {
  /** Null while loading. */
  branches: GitBranchesResult | null
  baseBranch: string | null
  useWorktree: boolean
  /** Called as the menu opens, to refresh the list. */
  onOpen?: () => void
  onBranch: (branch: string | null) => void
  onWorktree: (worktree: boolean) => void
}) {
  return (
    <Menu onOpenChange={(open) => open && onOpen?.()}>
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
            <MenuRadioGroup value={baseBranch ?? branches.current ?? ""} onValueChange={(value) => onBranch(value === branches.current ? null : (value as string))}>
              {branches.branches.map((branch) => (
                <MenuRadioItem key={branch.name} value={branch.name}>
                  <GitBranchIcon className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.is_current && <span className="shrink-0 text-muted-foreground/70">current</span>}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuCheckboxItem checked={useWorktree} onCheckedChange={(checked) => onWorktree(checked)}>
            <WorktreeIcon className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">Create a worktree from this branch</span>
          </MenuCheckboxItem>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}
