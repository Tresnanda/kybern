# Pre-release source comparison

Reviewed on 2026-09-06 against Kybern `591c265`. External repositories were
read locally at pinned commits; their applications and benchmarks were not run.
This is an architectural comparison, not a measured ranking of the three apps.

- T3 Code: `5fa35d211682ee02e34fba0711838ca431ed003b`
- Synara: `dcc7cbe1eb7d7dea75bd5c2e26914065a64a95b9`

## Findings

**Stable history is the right fix.** T3 Code uses a stable render callback,
memoized row components, and row-local subscriptions. Synara explicitly
reconciles timeline rows to preserve unchanged object identities. Kybern's new
per-transcript turn grouper follows this principle, allowing its existing
memoized Turn to skip unchanged history during another turn's updates.

Sources: [T3 Code timeline](https://github.com/pingdotgg/t3code/blob/5fa35d211682ee02e34fba0711838ca431ed003b/apps/web/src/components/chat/MessagesTimeline.tsx#L780),
[Synara stable rows](https://github.com/Emanuele-web04/synara/blob/dcc7cbe1eb7d7dea75bd5c2e26914065a64a95b9/apps/web/src/components/chat/MessagesTimeline.tsx#L2706).

**Both bound mounted transcript content more aggressively.** Their primary
timelines use LegendList. T3 Code also virtualizes expanded work groups and
initially requests the last 10 user-anchored turns, with 20-turn older pages.
Kybern now removes closed work panels, but maps all loaded turn groups into
the scroller. Many completed answers or a very large expanded work group can
still grow DOM and layout cost. Full virtualization needs independent checks
for variable heights, text selection, rail navigation, collapse/expand, scroll
restoration, streaming follow, and images loading after measurement.

Sources: [T3 Code lists](https://github.com/pingdotgg/t3code/blob/5fa35d211682ee02e34fba0711838ca431ed003b/apps/web/src/components/chat/MessagesTimeline.tsx#L820),
[T3 Code pagination](https://github.com/pingdotgg/t3code/blob/5fa35d211682ee02e34fba0711838ca431ed003b/packages/client-runtime/src/state/threads.ts#L43),
[Synara list](https://github.com/Emanuele-web04/synara/blob/dcc7cbe1eb7d7dea75bd5c2e26914065a64a95b9/apps/web/src/components/chat/MessagesTimeline.tsx#L2635).

**Synara puts explicit limits on streaming work.** It coalesces UI domain
events through a 100 ms trailing throttler. Its reveal loop advances each
animation frame but ordinarily emits React state at 40 ms intervals, with
first/final/catch-up exceptions. Code highlighting has a separate 160–1,000 ms
interval that increases with code length; settled content bypasses throttling.
Kybern applies each received event to the store and its smooth reveal can
update state each animation frame. Deferred text rendering helps responsiveness
but does not impose a frequency limit. Profile long prose and code streams
before choosing cadence; preserving final text and lifecycle-event order is
essential.

Sources: [Synara ingestion](https://github.com/Emanuele-web04/synara/blob/dcc7cbe1eb7d7dea75bd5c2e26914065a64a95b9/apps/web/src/routes/__root.tsx#L1949),
[reveal](https://github.com/Emanuele-web04/synara/blob/dcc7cbe1eb7d7dea75bd5c2e26914065a64a95b9/apps/web/src/hooks/useSmoothStreamedText.ts#L30),
[highlight cadence](https://github.com/Emanuele-web04/synara/blob/dcc7cbe1eb7d7dea75bd5c2e26914065a64a95b9/apps/web/src/components/ChatMarkdown.tsx#L1142).

**Markdown and scroll work remain worth profiling in Kybern.** T3 Code keeps
Markdown component types stable and caches settled highlighted HTML with an
LRU bound. Kybern creates its Markdown component overrides inside render and
does not cache highlighted HTML across code-block mounts. Its message rail
also reconstructs previews across mounted messages on subtree mutations and
scans message rectangles during scrolling. Synara coalesces trail-highlight
scroll calculations to one animation frame and uses cached preview derivations.
These are source-identified scaling risks, not additional measured regressions.

Sources: [T3 Code stable renderers](https://github.com/pingdotgg/t3code/blob/5fa35d211682ee02e34fba0711838ca431ed003b/apps/web/src/components/ChatMarkdown.tsx#L2635),
[highlight cache](https://github.com/pingdotgg/t3code/blob/5fa35d211682ee02e34fba0711838ca431ed003b/apps/web/src/components/ChatMarkdown.tsx#L1004),
[Synara scroll handler](https://github.com/Emanuele-web04/synara/blob/dcc7cbe1eb7d7dea75bd5c2e26914065a64a95b9/apps/web/src/components/chat/MessagesTimeline.tsx#L1264).

## Release assessment

The comparison supports the direction of `591c265`; it does not reveal a
reason to discard its measured scrolling/commit improvements. Ship it as a
focused improvement with the existing 80-test, build, and native WebKit
material validation. Do not claim parity with these projects or universally
smooth performance. Their implementation choices do not validate Kybern's
native glass rendering or predict its CPU use.

Follow-up priority: measure and bound growing-message Markdown/highlighting
work; then virtualize long history and large expanded work groups; then remove
whole-history rail preview/layout work where profiling confirms its cost.
The existing 7 ms synchronous streaming-update p95 does not measure all later
reveal, deferred Markdown, layout, and GPU work, or concurrent typing latency.
No runtime implementation changed in this review and no release was published.
