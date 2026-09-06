# Changelog

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
