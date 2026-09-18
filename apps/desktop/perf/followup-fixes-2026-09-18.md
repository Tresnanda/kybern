# Follow-up desktop fixes — 2026-09-18

## Prompt rail

The virtual transcript index created an extra assistant entry after each settled
turn. It now emits one strip per actual user prompt, including prompts in
unmounted history. Assistant opening text remains secondary context in the
user prompt's hover preview. Assistant-only continuation groups produce no
strips. The generic DOM fallback follows the same rule and stops searching for
answer context at the next user prompt.

Unit checks cover 400 turns → 400 prompts, assistant-only groups, stable streaming
previews and edited text. Native production-CSP rendering and interaction fixtures
cover 61 exact user-prompt targets, first/middle/latest navigation, follow behavior,
reading position, selection/focus, prepend anchors and unmounted history.

## Draft image thumbnails

Saved drafts correctly omitted ephemeral blob URLs, but the composer only
rendered a thumbnail when that URL existed. The new mounted attachment component
fetches the already-uploaded asset through the owning environment's authenticated
HTTP endpoint. Drafts still retain only IDs and metadata, without image payloads.
Temporary preview URLs belong to the mounted component and are revoked when it
leaves or is removed. Pending reads are aborted; failures expose a retry action.

The native chat-fixes fixture switches away from an image draft, revokes its old
URL, returns, verifies a new loaded thumbnail, opens the original image, removes
it and verifies URL revocation. It also exercises failed-load retry and leaving
while a preview is loading. Fetching waits for the owning environment to connect;
the connection transition restores the thumbnail automatically. A read-only peer
review caught this readiness edge case, which is now covered in the native fixture.
Checks run in light and dark modes at
`tauri://localhost` under production CSP.

## Narrow workspace and composer

The right dock previously calculated its maximum from the whole window, ignoring
the sidebar and remaining chat area. It now observes its actual containing width
and reserves 320 pixels for chat. If a usable dock and chat cannot fit beside each
other, the dock overlays the chat and retains its existing Collapse panel action.
The native chat-fixes fixture renders the actual App at 900 and 1300 pixels with
a 480-pixel sidebar, checks chat/dock widths and responsive mode, and closes it.
The overlay makes the covered chat inert, moves focus into the panel and restores
the previous control when closed. Its ResizeObserver is disconnected on unmount.

Horizontal splits reserve at least 320 pixels for each pane, clamp pointer and
keyboard ratios to the available width and stack vertically below 656 pixels.
The composer uses container width to compact model/effort and queue labels in
both single and split views while preserving named buttons and tooltips. Native
checks cover 280/320/400-pixel running composers, real split panes at 650/900
pixels, keyboard resizing, control hit testing, and the existing 60 combined
activity/question/approval layout samples.
The send/stop glyph uses an opaque contrast token so a translucent surface token
cannot make it disappear inside the action button.

## Completion indicators and read state

Completed inactive threads now show an accent unread dot in the sidebar as well
as the bell. Read acknowledgement follows the selected thread, document visibility
and actual native window focus. Returning to a foreground thread clears its
completion without clicking it again. Inactive split panes remain unread.
Sequence/generation checks reject stale focus responses, including replies after
a window blur. Runtime disconnect removes the listeners and a new runtime
reinstalls them.

Deterministic runtime tests cover completion, resumed-turn deduplication,
background waves, inactive split panes, hidden windows that still report native
focus, asynchronous focus/blur races and reconnect. The native work-shell fixture
asserts the real sidebar dot with 1,000 threads and 20 projects.

## macOS update permissions: partial fix, release identity still required

Read-only inspection of `/Applications/kybern.app` found `Signature=adhoc`, no
TeamIdentifier and a designated requirement tied to that exact build's cdhash.
The release script also unconditionally re-signed its output ad hoc, discarding
any certificate identity Tauri might have applied. Apple explains that privacy
grants are checked against the app's previous designated requirement:
[TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements),
[Apple DTS confirmation for Screen Recording](https://developer.apple.com/forums/thread/819406).

Packaging now preserves certificate signatures, verifies the app and bundled
daemon, rejects a silent ad-hoc downgrade when a certificate was requested, and
accepts optional Apple signing/notarization secrets in CI. Its verifier checks
bundle identity, matching signing teams and certificate-based requirements.
Ad-hoc builds remain available without a paid membership, with an explicit
permission-persistence limitation. Eight release/signature-policy tests and
shell syntax checks pass; the verifier also checks the installed ad-hoc bundle
without changing it.

The user has a free Apple account, with no Developer ID Application certificate
available locally or configured in repository secrets. No membership, private
key, trust setting, TCC grant or installed signature was changed. A Developer ID
release and before/after permission-grant test could not be performed. The
existing ad-hoc update path can therefore still require reauthorization. This
item is not claimed fully fixed. Certificate-based release setup is documented
in the root README; changing from the old ad-hoc identity may require one new
grant even after that setup.

Tauri configuration was checked using Context7 and the upstream
[macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).

## UI previews

Actual native screenshots are kept in the original workspace's
`perf-artifacts/followup-ui-20260918`. `readable-command-menu.png` uses macOS
window capture because WKWebView snapshots omit backdrop compositing; it shows
the shipping one-layer blur over busy text. `image-actions.png` shows the image
viewer Copy/Download actions. The earlier environment menu, answer review and
Terminal corner previews remain in `perf-artifacts/desktop-polish-20260918`.
`narrow-composer.png` shows the actual compact running composer.

## Combined checks

All 244 desktop unit tests pass. Typecheck, ESLint and the production frontend
build pass; the build retains existing chunk-size/dynamic-import warnings.
Native chat-fixes and composer-stack run with the production CSP in system
WKWebView. Earlier prompt-rail rendering/interaction and completion work-shell
checks also passed. No installed app replacement, release or push was performed.
The running production app and daemon were preserved during this follow-up.
