# Renderer memory, diagrams, profiles and opaque panels

Follow-up in the same isolated worktree as the [paint-boundary fix](rendered-history-memory-2026-09-14.md), based on `1c7e3c7`. The installed application and the other development checkout were not replaced. This work addresses [#9](https://github.com/Tresnanda/kybern/issues/9), [#10](https://github.com/Tresnanda/kybern/issues/10) and [#11](https://github.com/Tresnanda/kybern/issues/11), and reduces another source of retained data relevant to [#14](https://github.com/Tresnanda/kybern/issues/14).

## Markdown retention

Every parsed Markdown block retained its HAST node and a full JSON serialization of that node as an equality signature. Workers also transferred both copies to the renderer. Exact structural comparison now reuses unchanged nodes without retaining or transferring the serialized copy. Positions, link properties, stable block keys, incremental parsing and formatted output are preserved; no probabilistic hash decides whether content changed.

The new `markdown-memory` fixture deliberately retains eight large parsed documents, each with 350 sections containing a heading, formatted paragraph, link, inline code and GFM table. It isolates parsed-data retention without mounting a transcript. This is a diagnostic workload, not the normal inactive-chat cache policy.

Apple M1, 16 GiB, macOS 27.0 (26A5416b), system WKWebView, production CSP at `tauri://localhost`. Fresh native processes, no live provider or forced GC. Native `vmmap` samples run after parsing and after 32 seconds of worker idle; normal user activity continued. The deterministic retained-size estimate and native physical footprint measure different things.

| Measurement | Original parser | Updated parser | Updated repeat |
| --- | ---: | ---: | ---: |
| Estimated retained parsed data | 79.92 MiB | 55.50 MiB | 55.50 MiB |
| Physical footprint after parsing | 295.1 MiB | 212.7 MiB | 281.3 MiB |
| Physical footprint after worker idle | 125.8 MiB | 83.5 MiB | 108.8 MiB |
| Lifetime peak physical footprint | 296.2 MiB | 250.4 MiB | 281.6 MiB |

The retained-data reduction is 30.5%, or 24.4 MiB in this fixture. Native allocation/collection varies substantially, so the footprint samples do not establish a universal percentage. An earlier original-parser sample measured 260.4 MiB after parsing and 99.9 MiB after idle; its diagnostic retained-size counter was invalid because it reused a mutated array in the immutable-object estimator. The table uses the corrected fixture, which estimates a fresh array of retained results.

The unit regression fails with the old duplicate payload and passes after removal. It also checks exact comparisons across structured clones, changed reference links and changed positions. Existing every-prefix parsing comparisons continue to match the full formatted renderer. The native fixture guards retained data below 60 MiB while requiring all eight structured documents to remain present.

The final rendered-history stress sequence still passes its independent memory and rendering assertions: **416.9 MiB history peak, 801.1 MiB full-sequence peak**, 1,600 nonempty sampled frames, and 18 ms frame-interval p95 in all eight stages. This preserves the earlier graphics improvement; it does not demonstrate another large reduction in that workload. Large Markdown retention and fast-history paint allocations are separate costs. There is still no whole-application 1 GiB cap or controlled two-hour resting-memory result.

## Peer source review

Read-only clones of the current default branches on 2026-09-14 informed the review:

- [T3Code, `3b75e607`, ChatMarkdown](https://github.com/pingdotgg/t3code/blob/3b75e607eb909522a8f5562fb40e44efc72bb66c/apps/web/src/components/ChatMarkdown.tsx): highlighted-output LRU bounded by 500 entries and 50 MiB.
- [Synara, `70f5ed0e`, subscription retention](https://github.com/Emanuele-web04/synara/blob/70f5ed0e4757c0f69891b258171da80d324f0e18/apps/web/src/threadDetailSubscriptionRetention.ts): 32 cached thread-detail subscriptions, 15-minute eviction, retaining actionable/live state.
- [Synara syntax highlighting](https://github.com/Emanuele-web04/synara/blob/70f5ed0e4757c0f69891b258171da80d324f0e18/apps/web/src/lib/syntaxHighlighting.ts): 500 entries, 50 MiB, and a 250,000-character input limit.

Kybern already has smaller budgets: 16 MiB for inactive transcript/diff retention, 8 MiB/24 entries for parsed Markdown, and 4 MiB/24 entries for highlighted output, with worker release after 30 seconds. Those limits remain. No peer code was copied and these applications were not benchmarked.

Reducing tool overscan from eight to four rows produced inconsistent full-sequence peaks (718 and 823 MiB). Removing promotion hints or scroll masks, and promoting nested rows, made graphics memory worse in this workload. Those experiments were reverted. Useful motion, scroll fades and the existing mounted-row budget remain.

## Bounded history retries

The final history regression intermittently failed because one Retry fetched every remaining page while the viewport stayed at the top. A smaller reproduction using the actual history hook, without a virtualizer or further input, consistently fetched five pages from one retry. The scroll-intent flag remained active when cursor/loading changes scheduled the next check; neither duplicate clicks nor Markdown formatting was necessary.

Each request now consumes that intent. A new wheel, keyboard, touch or pressed-pointer movement can request the next page, while hovering, layout updates and cursor changes cannot. The regression first fails on the five-page burst, then verifies one-page retries, continued input and the original full transcript's paging/anchor behavior. Three native repeats passed with eight mounted rows and at most 0.68px anchor movement. This bounds unnecessary history downloads; it is not included in the memory percentages above.

## OMP profiles (#9)

Settings → Agents exposes a default OMP profile and overrides keyed by the registered project's absolute path. Worktrees inherit that project. The profile selector exposes inheritance, OMP's unnamed default, and named profiles; project overrides are grouped in a disclosure. Launch, saved-session discovery/import, model discovery and skill roots receive the same effective environment. Native profile-name validation follows OMP's bootstrap rules and prevents profile paths from escaping their root.

A thread retains its original profile across idle process release and later default changes. Imported sessions retain the profile used to find them; CLI `resume --project` supplies the same context as `sessions --project`. Older threads acquire the binding at their first launch with this version. A failed executable launch does not establish a binding.

A fake OMP executable exercises the real process driver: a worktree launches with its project profile, resumes with that profile after settings change, and a new chat uses the changed default. Provider settings and the additive resume context are synchronized across Rust and the shared TypeScript client. The settings schema snapshot was reviewed and updated.

## Mermaid (#10)

Fenced Mermaid renders after streaming settles, with source/diagram and exact-source copy controls. Invalid, incomplete or oversized definitions stay readable as source. The existing code-block chrome and transcript row state are reused.

Mermaid is a separate lazy bundle running in a disposable rendering document because SVG text measurement needs a DOM. It uses strict security and locked source/edge limits. Returned SVG is displayed as an inert image, without inserting its markup or handlers into the transcript. The queue is bounded and cancellation-aware; the cache holds at most eight entries/2 MiB. The rendering document and cache are released after 30 seconds of idle, and image URLs are revoked on replacement/unmount. Finished images stay visible after the rendering document is released.

The native production-CSP fixture renders six diagram families in both themes, checks decoded images and SVG labels, exact source/copy, incomplete/invalid fallbacks, settled DOM identity, URL cleanup and idle release/restart. Mermaid 12.0.0 is exact-pinned. The initial application does not instantiate its renderer.

## Opaque composer panels (#11)

Opaque mode now uses an opaque fill and no backdrop blur for the composer and stacked panels. Translucent mode retains the shared glass recipe. Reduced-transparency and increased-contrast preferences use the opaque fallback. The regression first reproduced the previous 40px blur in opaque mode, then passed after the token/CSS fix.

The material fixture checks dark/light, opaque/translucent and emulated accessibility preferences, including the pseudo-element that owns the blur. The actual composer-stack fixture checks opacity and blur across 60 panel/layout cases. A full rendered fixture with the real composer and queued panel measured 823.4 MiB peak with legacy blur and 822.2 MiB without it: this is a correctness fix and removes unnecessary blur, not evidence of a meaningful peak-memory reduction.

## Verification

Desktop: 134 tests, typecheck, lint and production build pass. Rust: formatting, workspace Clippy with warnings denied, workspace library/binary tests (255 passed, three existing ignored tests) and protocol schema tests pass. No live provider integration tests were invoked. The scratch sidecar was staged only in this worktree to satisfy Tauri's build checks.

Mobile: typecheck, 83 tests and Android/iOS Expo exports pass. Expo Doctor passes 20/21 checks; its dependency-version check reports 19 newer Expo patch releases than the existing exact pins. No mobile dependency versions were changed.

Native rendering, scaling, work-stream, interaction at 1100/480px, history paging, saved-session picker, diagram, profile at 1100/480px, material and composer-stack checks pass. Screenshots were inspected for diagram labels, profile controls and stacked-panel appearance. Rendering retains 30/30 historical code wrappers and exact final text. Scaling retains eight mounted history messages, with 18 ms streaming frame p95 and 16 ms synthetic input-to-frame p95. These checks measure rendering and synthetic input separately; CPU and energy were not measured for this change.

Run the new checks from `apps/desktop`:

```sh
node scripts/check-rendering.mjs markdown-memory
node scripts/check-rendering-memory.mjs
node scripts/check-rendering.mjs profiles
node scripts/check-rendering.mjs mermaid
node scripts/check-rendering.mjs composer-stack
node --experimental-strip-types scripts/check-window-material.mjs
```

For the composer memory comparison, set `KYBERN_SCROLL_COMPOSER=1`; the fixture-only `KYBERN_SCROLL_COMPOSER_GLASS=1` restores the old blur for a controlled baseline. These fixture flags do not enter the shipped frontend.
