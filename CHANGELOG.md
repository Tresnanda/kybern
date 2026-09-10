# Changelog

## 0.3.6

- Recover stuck agent turns when an interrupt is acknowledged without a final result or the provider stops responding. After a five-second cancellation deadline, close the stuck session and allow the conversation to resume.
- Settle outstanding tasks and approvals during forced stops, preserve recorded usage, and prevent late events or stale stop requests from affecting newer responses.

## 0.2.5

- Keep Claude background agents and processes in the same running turn across follow-up work, and prevent premature or duplicate completion notifications.
- Keep agent images in chronological work order until the turn completes. Show generated images with the final response and inspection screenshots inside their tool results.
- Open image previews from composer attachments and sent messages, with focus restored after closing.
- Preserve Shift+Enter newlines in sent messages.
- Refine the environment picker with aligned rows, clearer status, and a new-window action beside each environment that leaves the current window unchanged.
- Reuse release build caches from main, cross-compile Intel Mac builds on faster ARM runners, and avoid duplicate artifact uploads.

## 0.2.4

- Resume conversations started in Claude Code, Codex, OpenCode, pi, OMP, or Cursor CLI. Open **Resume session** beside **New thread**, from a project's menu, or with `/resume` and `/sessions`.
- Find saved conversations by title, project, folder, or session ID with an **All agents** filter. Import available message and tool history, preserve the native session, and reopen existing Kybern threads without duplicates.
- Keep Claude background completions and follow-up tools in their original turn. Automatically continue when native background work finishes and replace provisional waiting messages with the final answer.
- Preserve continuation state, usage, and history across reloads. Add regression checks for all six session formats, atomic imports, keyboard navigation, and light/dark and narrow native layouts.

## 0.2.3

- Reduce retained conversation memory with bounded inactive caches, compact background updates, and cache release when switching environments. Preserve drafts, pending controls, split panes, and live updates during history reloads.
- Bound event, terminal, and WebSocket buffers by bytes, with durable event replay and terminal scrollback recovery for slow clients.
- Release idle Markdown and highlighting workers and cap provider discovery cache entries.
- Show compact, deferred image thumbnails and load full-resolution originals only when opened.
- Fix table wrapping and horizontal overflow in narrow conversations.
- Add Open in new window to environment menus with independent environment selection per window.
- Add native memory comparisons and regression coverage for rendering, image previews, cache eviction, and recovery.

## 0.2.2

- Count time asleep toward idle agent expiry, so overdue processes close on the first cleanup sweep after waking.
- Stop opening threads, reconnecting, and subscribing to events from extending idle agent lifetimes. Conversations still resume on the next message.
- Preserve active work and approval waits, and recheck activity before closing a selected idle process.

## 0.2.1

- Redesign agent question forms with clearer hierarchy, multiline answers, quieter choices, and responsive action layouts.
- Fix context usage warnings turning near-black instead of amber at 80–94% usage.
- Open local image links in an authenticated in-app preview and provide useful recovery guidance for blocked image paths.
- Give agents thread-specific artifact guidance and document preview placement in the repository instructions.
- Preserve the desktop performance findings and visual-quality requirements in AGENTS.md, CLAUDE.md, and the performance guide.
- Add native WebKit regression checks for question forms and artifact previews.

## 0.2.0

- Virtualize long conversation histories, expanded tool groups, and agent activity to keep mounted interface work bounded.
- Move large Markdown parsing off the interface thread and reuse completed blocks as text streams, preserving GFM, links, footnotes, code controls, and exact final output.
- Navigate every message through a virtualized rail with keyboard support and bounded geometry reads.
- Preserve reading position, following, selections, focus, wrapping, and expansion state while virtual rows mount and unmount.
- Fix sidebar context menus and submenus appearing transparent without blur in Translucent app mode.
- Add M1 native WebKit measurements and regression checks for large histories, growing Markdown, navigation, tool expansion, and menu materials.

## 0.1.9

- Make cards, controls, message bubbles, menus, and dialogs consistently translucent in Translucent app mode.
- Improve long-thread scrolling by preserving settled turn identities and removing collapsed work details from the rendered page.
- Move syntax highlighting off the interface thread, bound queued work and cached results, and pace highlighting while code streams.
- Preserve code-block wrapping and highlighted content while surrounding Markdown updates.
- Reduce streaming Markdown updates and cache message-navigation previews to avoid repeatedly reading historical messages.
- Add native WebKit rendering regression coverage using the production content security policy.

## 0.1.8

- Fix Translucent app mode remaining opaque outside the sidebar on macOS.
- Add native WebKit regression coverage for window materials, settings, floating surfaces, and accessibility fallbacks.

## 0.1.7

- Reduce running-indicator repaint work and pause looping indicators when they are hidden or offscreen.
- Fix full-app translucency being hidden by an opaque content wrapper, and avoid stacking an extra tint in split panes.
- Redesign the context-usage popover with clearer token counts, usage meters, separate account limits, and keyboard access.
- Keep native ResizeObserver layout diagnostics out of fatal error banners and defer resize work to the next frame.
- Replace raw interface-error banners with a compact notice with expandable technical details, copy, and dismiss actions.
- Rebuild the mobile client around native tabs and Liquid Glass surfaces, with updated connection, thread, approval, and settings screens.

## 0.1.6

- Start drafting immediately while harness discovery refreshes, with cached harness choices on subsequent launches.
- Show context usage in the composer, with token details, supported account usage windows, and reset times on hover or focus.
- Add native manual compaction and discovered slash commands where supported by each harness.
- Add full-app translucency in Appearance, including floating surfaces and the terminal, with accessibility fallbacks.
- Fix composer wrapping, caret scrolling, and spacing alignment.
- Close owned harness processes reliably during session release and failed startup; preserve conversation history and provide safe reconnect guidance for Codex writer conflicts.
- Prevent Codex from appearing as its own subagent after resume, and exclude old false entries from activity views.
- Render Codex asynchronous questions as answerable forms. Keep unanswered forms across reloads and deliver submitted answers while the agent works.

Account limits and commands depend on the installed harness protocol. Kybern does not infer missing quotas or expose unsupported terminal-only commands.
