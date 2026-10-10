# Account selection, shared assets and inline expansion

PR #104 covers the model picker returning to CLI Claude, ADE-41, and ADE-42.

## Account selection

The original PR retained the provider catalog during a settings refresh. A second
failure used the same `default` value for two meanings: the actual CLI account
and following project/provider defaults. Selecting CLI Claude in a draft could
therefore immediately display the second account again when that account was the
default. An explicit picker selection now records a pin, including the CLI
account. New-thread creation persists it; unpinned drafts continue following
defaults. The Usage rail is no longer needed to select CLI Claude.

Skill requests now carry the selected account. The daemon honors it ahead of
project/global defaults. The desktop cache scope includes environment, project,
provider and account, and refreshes when the suggestion picker opens or settings
change. Mobile sends the account for suggestions and structured skill expansion.
Native Codex/OpenCode catalogs retain authority over enabled/disabled entries.

## Shared assets

The regular provider directory is the shared source. Configured provider roots
are honored. Isolated account directories link only reusable assets:

| Provider | Shared assets |
| --- | --- |
| Claude Code | Skills, commands, plugin cache, marketplaces and installation/marketplace registries |
| Codex | Skills and plugin cache |
| Cursor | Skills; native discovery already uses the regular home directory |
| Pi / Omp | Skills and extensions; Omp uses the configured global profile when present |
| OpenCode | Skills and plugins under the provider config directory |

Preparation runs on daemon settings load, account creation/sign-in completion,
account probes, skill discovery and session preparation. Missing imported account
folders are skipped. It is idempotent and serialized within the daemon.

Existing local content is renamed beside its original folder as
`<name>.kybern-local-<uuid>`. Unique files move into the shared directory;
conflicting files remain in that backup, with shared content winning. Registry
objects/arrays merge missing entries without replacing existing values. Imported
symlink targets are copied without changing the original tree. Relative links
retain their target; plugin installation paths migrate to the shared cache so
removing the original account does not break another account's plugins.
Replacement symlinks are created before moving content, so unavailable symlink
support fails before migration. Invalid content produces an actionable error and
restores the original local path. Backups are preserved until explicitly removed
with the account or by the user.

Credential files, sessions, plugin runtime data, and complete settings files are
never linked. Only Claude's boolean plugin enablement entries are merged as
missing defaults; existing account choices remain intact. MCP configuration,
headers, environment secrets, OAuth state and provider API keys remain separate.

Shared local plugin files do not grant remote service access. Codex's remote
plugin installation catalog and connected services can depend on the authenticated
account. Those services still require their own account-specific install/sign-in;
discovery does not bypass native disabled-plugin or entitlement policy.

## Settings action specification

Recommendation: add **Sync configuration…** to the account menu for a provider
with at least two accounts, as a separate future feature. Do not automatically
link configuration files: they combine portable settings with secrets and local
preferences. The current change adds explanatory copy about shared assets.

1. Open a kit dialog titled **Sync configuration**. Show the source account,
   selectable target accounts of the same provider, and categories. Default to
   portable preferences only; connections require an explicit selection.
2. Allow model/effort defaults and documented non-secret provider preferences.
   For MCP, copy server names, transport, command/arguments or URL only after a
   provider-specific allowlist/redaction pass. Treat all environment values,
   headers, URL userinfo/query credentials, OAuth tokens and opaque unknown
   configuration as private. Never copy hooks or arbitrary executable configuration
   by default. Service sign-in stays with the target account.
3. Show a per-target diff before writes: additions, conflicts, unsupported values,
   and **Sign in required** connections. Default to **Add missing settings**.
   Replacing an existing value must be an explicit per-conflict choice. Secret
   values must not appear in diffs, notifications, logs or RPC responses.
4. The final button is **Sync configuration**, with an affected-account count.
   Write each target atomically, preserve a recovery copy, and compare source/
   target revisions to avoid overwriting concurrent native CLI changes. Keep
   credentials in their original files/keychains. Make retry idempotent.
5. Report success or actionable per-target failure, refresh account catalogs and
   skill pickers, and apply session-affecting changes to the next session. Offer
   **Review connections** for targets needing their own sign-in. Provide a
   restore action for the portable configuration changes only.

The dialog must use existing kit grouping, typography, logical spacing, keyboard
focus and error patterns. At narrow widths it becomes a stacked, scrollable
review with persistent actions. It must work with RTL, larger text, reduced
motion, light/dark and opaque materials. Implementation should add a scoped
preview/apply RPC pair and dedicated allowlist tests before exposing the action.

## UI review

Reviewed with better-ui, better-typography, better-layout, better-writing and
apple-design. The relevant Apple HIG principles are predictable
[modality](https://developer.apple.com/design/human-interface-guidelines/modality)
and immediate [feedback](https://developer.apple.com/design/human-interface-guidelines/feedback).

### Predictable action and feedback

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH, fixed | `src/components/kybern/ModelPicker.tsx:362`; `src/views/Draft.tsx:54`; `src/state/rpc.ts:239` | CLI selection could return to the default account; refresh could remove controls. | Explicit CLI pin survives defaults and catalog refresh/failure. | Selection must visibly apply at the control where the user makes it. |
| HIGH, fixed | `src/views/VisualReply.tsx:162` | Expand opened another preview in the sidebar. | The same iframe expands in the native dialog top layer, preserves state, and returns focus when closed. | Expansion should preserve the current task and offer a clear way back. |

### Hierarchy, layout and writing

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM, fixed | `src/styles/kit.css:3468`; `src/views/VisualReply.tsx:186` | Expansion had no dedicated close/title chrome. | Token-based surface and typography; logical padding, truncated title with full tooltip, labeled close action; inline space remains reserved. | Clear hierarchy and stable reading position at narrow widths and RTL. |
| MEDIUM, fixed | `src/views/settings/AccountsSettings.tsx:141`; `src/views/VisualReply.tsx:195` | Sharing behavior was unexplained; expand label described opening a panel. | Brief shared-assets explanation and **Expand preview** copy. | Labels describe the resulting behavior; wrapping preserves readability. |

## Verification

- Desktop: 501 tests; typecheck, lint and production build passed. Existing Vite
  chunk-size/dynamic-import warnings remain.
- Rust: daemon library suite 509 passed, six ignored; protocol tests 27 passed.
  Formatting and clippy for daemon, CLI and protocol passed with warnings denied.
- Mobile: 165 tests, typecheck and Android/iOS Expo export passed. Expo Doctor
  passes 20/21 checks; its package-version check flags existing SDK patch pins.
  Dependency versions were not changed.
- Native WebKit under the production CSP: draft switches from second/default
  Claude to CLI and back during held/failed catalog refreshes. Inline expansion
  leaves sidebar state untouched and keeps the iframe, ticket and interactive
  counter. Closing restores focus; the cancel event returns to inline. Normal
  height posts and expansion preserve the inline placeholder. Existing dock
  source/export, theme changes, hidden-loop pause, loading/error/retry, measured
  layout, formatted table and SVG chart checks passed.
- Native appearance: expanded light/dark, RTL with 200% root text, expansion from
  a 360 px pane, and Accounts dark at 1100 px/light at 390 px passed. Accounts
  rename/default/project assignment/removal/refused-save rollback passed.
- Filesystem/RPC regressions cover all six providers, existing/new accounts,
  shared updates, conflict preservation, credential/session isolation, registry
  merging, relative/imported symlinks, invalid assets, unavailable account roots,
  explicit CLI skill requests and project/default fallback.

Not verified: real provider account sign-ins/remote plugin service activation,
Windows symlink privileges, mobile device rendering, screen-reader narration,
physical Escape-key routing from iframe focus, actual browser zoom, and large
virtualized-history expansion during concurrent autoscroll. The cancel handler
and 200% root-text checks are narrower tests. No timing/CPU/energy improvement is
claimed. No new animation was introduced, so slow-motion replay is not applicable.

Provider behavior was checked against current primary documentation through
Context7: [Claude authentication](https://code.claude.com/docs/en/authentication),
[Claude plugins](https://code.claude.com/docs/en/plugins/overview), and
[Codex plugin management](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/manager.rs).

Approve — inspected surfaces and checks above only. No unresolved HIGH finding
was found in that scope; the listed unverified environments remain outside this
approval.
