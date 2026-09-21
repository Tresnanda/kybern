# Changelog

## 0.4.13

<!-- kybern-release-title: Free chats and clearer conversation context -->
<!-- kybern-release-summary: Start chats without a project, keep drafts visible, see message timing, and steer agents while background work continues. -->

- Start project-free chats from New chat and find them in a collapsible Recents section beneath Projects, with an isolated neutral workspace instead of repository controls.
- Keep unsent work visible with pencil indicators for new-chat and thread drafts, and show the remaining provider prompt-cache window in the composer.
- Group conversations by date and show message timestamps so earlier prompts and responses are easier to place in time.
- Send new instructions while supported harnesses continue background tasks, including Claude Code continuation support and parity checks for other providers.

## 0.4.11

<!-- kybern-release-title: Clearer chat controls -->
<!-- kybern-release-summary: Clear stale notifications and see terminal activity, helper harnesses, and submitted answers more clearly. -->

- Add Dismiss all to clear stale notifications, including errors and pending requests, while allowing new attention events to appear.
- Clarify submitted answers, terminal commands, and background activity with dedicated icons, and show overlapping harness logos for helper threads.
- Refine thread menu spacing and composer input sizing, and remove the overlapping fades when opening Settings.

## 0.4.10

<!-- kybern-release-title: Sidebar blur restored -->
<!-- kybern-release-summary: Restore the frosted macOS sidebar when full translucency is turned off. -->

- Restore native sidebar blur in normal appearance mode so windows behind Kybern no longer show through sharply. Full-content translucency remains optional.
- Correct the regression-test fixture that blocked the unpublished 0.4.9 release. Theme startup and translucency toggles remain covered by release checks.

## 0.4.9

<!-- kybern-release-title: Sidebar blur restored -->
<!-- kybern-release-summary: Restore the frosted macOS sidebar when full translucency is turned off. -->

- Restore native sidebar blur in normal appearance mode so windows behind Kybern no longer show through sharply. Full-content translucency remains optional.
- Add a release regression check covering theme startup and translucency toggles.

## 0.4.8

<!-- kybern-release-title: Quieter helpers, reliable follow-ups -->
<!-- kybern-release-summary: Helper threads stay out of notifications, and follow-up assignments wait until the helper is ready. -->

- Keep helper completions, failures, approvals, and questions out of the notification bell, unread dots, toasts, and system alerts. Details and approval controls remain available inside the helper thread and Work panel.
- Queue follow-up assignments while a helper is busy, and separate queued, working, and attention counts in the Work panel.
- Restore macOS release packaging when optional Apple certificate settings are empty. This release includes the fixes from the unpublished 0.4.7 build.

## 0.4.7

<!-- kybern-release-title: Quieter helpers, reliable follow-ups -->
<!-- kybern-release-summary: Helper threads stay out of notifications, and follow-up assignments wait until the helper is ready. -->

- Keep helper completions, failures, approvals, and questions out of the notification bell, unread dots, toasts, and system alerts. Details and approval controls remain available inside the helper thread and Work panel.
- Queue follow-up assignments while a helper is busy instead of incorrectly marking them as needing attention, then dispatch once the helper is available.
- Separate queued, working, and attention counts in the Work panel so stalled tasks no longer inflate the active count.

## 0.4.6

<!-- kybern-release-title: Lighter chats, clearer controls -->
<!-- kybern-release-summary: Long chats and tool-heavy turns use less peak memory, with clearer notifications, reviewed answers, and steadier agent updates. -->

- Reduce memory spikes in long chats and tool-heavy turns while preserving exact saved results, formatting, and useful motion. Large completed results load on demand, and unnecessary graphics layers and historical-result reads are avoided.
- Answer multiple agent questions one step at a time, move backward to edit, and review all answers before submitting.
- Refine the environment menu, add icon-only copy and download actions to image previews, and preserve pasted-image thumbnails when switching threads.
- Keep narrow composers contained and split chats readable, limit the message navigation rail to user prompts, and make translucent command, file, and skill pickers easier to read.
- Use smaller notification dots: blue for completed, yellow for pending or blocked, and red for errors. Right-click the bell to dismiss completed notices; successful helper completions no longer duplicate notifications.
- Add a new-thread control when the sidebar is collapsed, align active sidebar shapes with hover states, and improve unread completion indicators.
- Deliver collaboration updates without stale duplicate wakeups, and keep completed or reused helper agents' activity accurate across harnesses. Fixes #34 and #35.

## 0.4.5

<!-- kybern-release-title: Steady window controls -->
<!-- kybern-release-summary: The macOS traffic lights settle centered on the toolbar as the window opens, without needing a resize. -->

- The macOS traffic lights settle centered on the toolbar as the window opens, instead of drifting up after the first paint and needing a window resize to correct.

## 0.4.4

<!-- kybern-release-title: Unified settings chrome, steady window controls -->
<!-- kybern-release-summary: Settings share the thread sidebar's chrome and the macOS window controls stay aligned with the toolbar. -->

- Settings share the thread's chrome: the same sidebar width and drag handle, row density, icon set, and a flush content surface instead of an inset card.
- The macOS traffic lights stay centered on the toolbar instead of drifting upward after the window finishes opening.
- The sidebar gains a notification center; the bell reflects live status and filters the sidebar instead of opening a popover.
- Composer picker rows are single-line, and the send button, edit glyph, and top chrome use refreshed Hugeicons.

## 0.4.3

<!-- kybern-release-title: Less retained work, steadier history -->
<!-- kybern-release-summary: Large saved results load when opened, long chats retain less daemon memory, and refreshed icons and usage views keep the workspace clear. -->

- Saved tool results load when opened. Results shared across panes stay available while visible, and closing details releases their mounted content without losing exact output or reconnect recovery.
- The daemon avoids unnecessary transcript and notification copies, omits irrelevant history events from transcript reconstruction, and returns unused allocator pages sooner on supported platforms.
- Long histories start with a correctly sized viewport, avoiding an initial full-history mount and preserving the live edge while older content is released.
- Refreshed Hugeicons, integration controls, and usage details improve workspace consistency. Account limits stay with their environment when switching connections.
- Release publication now requires successful CI for the exact main-branch release commit and successful desktop bundles for every supported platform.

## 0.4.2

<!-- kybern-release-title: A clearer place for your preferences -->
<!-- kybern-release-summary: Explore dedicated settings, clearer usage insights, and a sidebar that keeps helper chats connected to their parent. -->

- Settings opens as a dedicated screen with search and grouped navigation. Notifications and background activity have their own pages, and returning keeps your workspace and focus.
- Preview light, dark, and system themes with a simple selection outline. Screen transitions respect keyboard navigation and reduced motion.
- Explore usage by date, agent, model, or day, with token and reported-cost summaries. Loading, empty results, and failures have clear recovery actions.
- Follow helper chats with indentation and connecting guides beneath their parent in the desktop sidebar.
- Command, file, and skill suggestions now match the composer width, and settings icons align with their labels.
- Cursor can discover the repository's project Agent Skills.

## 0.4.1

<!-- kybern-release-title: Lighter, steadier conversations -->
<!-- kybern-release-summary: Coordinators research before they act and can be deleted, helper results arrive once, and long chats use far less memory. -->

- Project coordinators research the project before implementing. The first send keeps your brief, delegates research, and asks for a reviewed overview before accepting edit or integration assignments; setup progress and your corrections survive restarts.
- Delete a coordinator once its work is inactive. Deletion archives it, keeps worker history, files, and knowledge, and frees the project to start a fresh coordinator.
- Helper results are delivered once. Reading a collaboration message now acknowledges it, so an agent no longer receives the same result again as a queued follow-up. This applies to Codex, Claude Code, OpenCode, Pi, OMP, Cursor, and coordinators.
- Spawned conversations collapse under their parent on desktop, phone, and iPad. Queued updates and delivered results show the sender and formatted content on demand, keeping routing details out of the reading flow.
- Long conversations, dense tool activity, and large code blocks use far less memory while scrolling. The desktop stress workload's peak dropped from about 875 MiB to about 390 MiB, streaming allocates less per token, and an idle conversation settles near 130 MiB.
- The transcript's bottom fade no longer masks the whole scroller on opaque windows, and icons only promote while they animate.

## 0.4.0

<!-- kybern-release-title: Bring your agents together -->
<!-- kybern-release-summary: Delegate across harnesses, keep project knowledge with a coordinator, and follow the work from your chats. -->

- Ask agents to read earlier conversations, contact other threads, and delegate work across installed harnesses. Follow their child chats and results from the conversation.
- Create a project coordinator from the familiar chat composer. It plans work, manages workers, and maintains shared project knowledge; switch its harness when it is idle.
- Choose the tools you want in the right sidebar with **+**. New workspaces start with the panel empty and remember your choices.
- See what changed when a desktop update arrives, with a dismissible release card and full release details. Install from **Update and restart** at the bottom of the sidebar, with download progress and retry after a failed installation.
- Preview Mermaid diagrams in conversations. Switch between preview and source, expand a diagram, or copy its definition; incomplete and invalid diagrams keep a readable source fallback.
- Choose a default OMP profile or override it per project in **Settings → Agents**. Worktrees inherit the project profile, while existing chats keep the profile they started with.
- Browse large conversation histories with lower memory use, while preserving selection, focus, row controls, and deliberate loading of earlier messages.
- Keep the composer and stacked panels readable when translucency or accessibility settings disable blur.

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
