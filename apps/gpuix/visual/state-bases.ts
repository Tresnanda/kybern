/** Bases reproduce the fixture/layout immediately before a state action. Area `bases` exports override these. */
export const stateBases: Record<string, string> = {
 'blur-dialog':'blur-dialog-base', 'blur-palette':'blur-palette-base', 'blur-popover':'blur-popover-base',
 'env-panel':'thread-header',
 'tasks-hover':'tasks-list', 'dock-tab-hover':'dock-agents',
 'dock-add-menu':'dock-base',
 'notes-hover':'notes-gallery', 'notes-quick-capture':'notes-gallery',
 'tasks-select':'tasks-list', 'tasks-quick-add':'tasks-list',
 'settings-hover':'settings-general', 'settings-focus':'settings-general',
 'pulls-hover':'pulls-list', 'pulls-merge-menu':'pulls-summary', 'pulls-review':'pulls-summary',
 'dialog-account':'settings-accounts', 'dialog-project':'shell-home',
 'dialog-worktree':'thread-header', 'dialog-worktree-checked':'dialog-worktree',
 'palette':'shell-home', 'shell-sidebar-hover':'shell-home', 'shell-new-chat-hover':'shell-home',
 'conversation-subagent-hover':'conversation-subagents', 'conversation-disabled':'conversation-empty',
 'conversation-model':'conversation-transcript', 'conversation-completion':'conversation-transcript',
 'blur-live-controls':'dock-live', 'blur-preview-header':'dock-preview-mini',
}
