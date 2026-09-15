# Settings screen and usage redesign

Settings is a dedicated application screen with its own navigation, search,
content column, and Back to workspace action. The existing workspace remains
mounted, inert and visually hidden so returning preserves local view state.
Keyboard entry and reduced motion skip the screen transition. Hidden dock panes
receive their inactive state; hidden workspace CSS animations are paused and
approval shortcuts cannot act behind Settings.

The visual direction follows Synara's dedicated settings navigation and centered
content, reviewed from its source at `dd88d9272f97e4dda5735281e73ce14de388ad25`.
Kybern retains its own kit controls, theme tokens, typography and motion helpers.
The sidebar groups destinations into Personal, Coding and System, with dedicated
Notifications and Background activity pages. Quiet category labels and compact
rows replace the oversized navigation heading. Appearance now has visual Light / Dark / System choices. Settings search matches
section names, descriptions and relevant setting vocabulary.

Usage has 7-day, 30-day and all-time filters, reported cost and token summaries,
a bounded daily chart, and agent/model/day breakdowns. Requests ignore late
responses after filter changes or unmounting. Loading, empty and failed states
are explicit; failures have retry. Same-filter refreshes retain the last loaded
content while fetching; changing filters never relabels old results. Breakdown rows are shown in batches of 20.
Dates use UTC to match the daemon's aggregation. Cost is reported cost, not an
invoice: the existing protocol does not distinguish zero cost from unreported
cost. Cache counts remain separate from input plus output counts.

## Verification

- Desktop: 193 tests, typecheck, lint and production frontend build passed.
- New `node scripts/check-rendering.mjs settings` fixture runs the real App,
  SettingsScreen and UsagePage in native WKWebView under the production CSP,
  using a synthetic transport and disposable website storage.
- Checks cover screen semantics, retained/inert workspace DOM, focus entry and
  restoration, search, theme changes, settings saves, agents, interrupted section
  and screen transitions, out-of-order usage responses, retry, empty data,
  date filters, menu Escape and screen Escape. All 25 checks pass, including
  category grouping and the new notifications/background destinations.
- Native profile checks passed, including save, inheritance, cancellation and
  slow-motion reversal. The unchanged 1,000-thread / 20-project work-shell
  fixture passed. These are regression checks, not a claim of improved CPU,
  memory, energy or whole-app frame rate.
- Dark and light appearance and usage previews were visually inspected. Narrow
  navigation reflows into a scrollable section strip. The 430px fixture passed
  with reduced motion emulated via the shipped CSS guards and matchMedia;
  this does not change the operating system's preferences.
- Large UI text at 430px and RTL content at 760px passed the horizontal
  overflow check. The RTL scrollport retains a right-side scrollbar to avoid
  WebKit counting its custom left scrollbar as overflow.
- The separate window-material checker could not capture its native window
  (`No material window capture`). Native transparency capture remains unverified.

Preview files are in `artifacts/settings-redesign/` and are excluded from Git.
The installed app, normal daemon and user data were not replaced. This change
requires a frontend rebuild; no daemon/protocol changes or new dependencies.
