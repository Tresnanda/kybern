# Changelog

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
