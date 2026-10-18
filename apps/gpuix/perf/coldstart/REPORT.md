# Cold startup and long-thread open

## Workload and acceptance method

Apple M1 MacBookPro17,1, macOS 27.0.1, Bun 1.4.0, 60 Hz Retina LCD.
Base b14b10f1; branch gpuix/perf-coldstart. Same validated native addon
SHA-256 f7c8af1c2f2558f6c1a5a3ce93b274cfaf5676ebb87ac438d0ad29d45960dc10
in both bundles. No native patch or rendering flag changes.

The reusable deterministic fixture contains 300 threads in 20 projects,
32,076 turns / 162,126 events, with twelve 1,000–2,500-turn conversations.
The saved startup conversation has 2,500 turns, mixed formatted Markdown,
code, tools and runtime task events. Later open targets an uncached 2,000-turn
conversation; the second launch uses the same warmed daemon.

Five paired repetitions alternate variant order. Fast warm starts can reach the painted milestones in two native submissions; continued presentation is confirmed for up to 1.5 seconds outside the recorded milestone clocks rather than misclassifying a faster start as a sleeping display. Each pair member gets a fresh
scratch daemon/database, then two fresh app processes (projection cold/warm).
Cold means fresh daemon projection caches and uncached app state; filesystem
caches are not purged. App spawn is time zero: daemon startup, seeding and schema
migration are excluded. The lightweight compiled .app uses debug daemon binaries,
not a full release build. It follows the startup lane's compiled-package approach.
KYBERN_FULL_RATE=1 throughout, opaque 1280×820, background window. No screenshots
or clock manipulation in acceptance timing. Automation/window availability and
CPU-painted text are observed upper bounds, not physical presentation fences.
Every final UI runner holds scoped caffeinate -d -u -w runner-pid; -u wakes an already sleeping display. Zero/near-zero startup submissions and zero app GPU resource samples are rejected. No global power settings change. display-audit.json flags prior invalid visual/app-profile samples after the 30-minute display timeout and locked-session composition failure were discovered. A second retry with caffeinate still submitted only one frame; screen-state confirmed locked: 1 despite displayAsleep: 0. Both that retry and the foreground diagnostic were rejected. The foreground activation probe was dropped; default background behavior is retained. Final UI runs require locked: 0 / displayAsleep: false (or zero) before and after. The session is never unlocked by the harness. The user unlocked it at 17:05Z; acceptance resumed in the fair queue. All final pairs are repeated awake. Raw post-draw submissions, polling, process inventory and build-marker guards are
preserved with each run. Fair quiet windows and bounded UI leases isolate runs.

## Root causes and evidence

1. Cold transcript reconstruction held the single SQLite connection mutex across
   complete history decoding and folding. Saved-thread hydration starts with the
   sidebar requests, so either could block the other. In the isolated preliminary
   profile, lists waited 714–1,236 ms behind reconstruction; bounded scan batches
   reduced those waits to 182–496 ms without changing response snapshots. The
   preliminary cold sidebar observation changed 2,361 → 1,126 ms.
2. Reconstruction repeatedly scanned all accumulated entries to find users,
   assistant segments and rows belonging to a completed turn. The batch-only
   daemon sample attributed 630 inclusive samples to project_transcript_through,
   including 280 assistant-segment lookup, 127 user deduplication, 102 completion
   and 101 next-segment samples (nested sample counts are not additive). Temporary
   lookup indexes remove this accumulated-history search work. Indexed-only cold
   2,000-turn open was about 0.80 s versus about 1.05 s baseline.
3. threads.target.get reconstructed every event, including all tool payloads,
   solely to inspect quota recovery on the latest turn. Multiple target requests
   during normal startup competed with threads.get and account/list RPCs. The
   indexed-only app trace still showed target reads taking roughly 0.3–0.7 s,
   and saved-page readiness around 2.26 s. Latest-turn quota evidence can be
   selected directly without decoding unrelated history. The final headless
   profile measured baseline target reads 327–337 ms versus 0.48–2.37 ms with
   identical 186-byte responses; all ten sequence-bounded transcript response
   snapshots also remain byte-equivalent. Headless profiles are valid while the
   screen is locked and are separate from deferred UI acceptance.
4. Existing auxiliary SQL queries were not the main issue: runtime-task reads
   use the v26 sparse index; provider usage/commands/questions took approximately
   4 ms each in diagnostic SQL reads. No schema migration is needed. Module load,
   fonts, native first layout and RPC ordering remain in per-run timelines and
   app/daemon sample files, separate from acceptance measurements.

## Changes, file by file

- crates/kybern-store/src/lib.rs: replay in batches of at most 128 events and a
  256 KiB payload budget (one larger event is allowed to make progress); release
  the connection mutex before folding. Use the borrowed compact tool-completion
  decoder for omission-aware projection, preserving full replay and historical
  omission semantics. Add latest_turn_quota_events, selecting only quota evidence
  since the latest turn start in one SQLite snapshot. Add boundary, snapshot,
  oversized payload and sparse-evidence tests.
- crates/kybern-store/src/projection.rs: temporary user/message/turn indexes
  preserve identities, reused IDs and assistant segments while avoiding repeated
  history scans. Rebuild only when recovery can replace rows. Indexes die with
  the fold and do not add retained transcript cache state.
- crates/kybern-daemon/src/orchestrator/accounts.rs: target hydration and switch
  continuation use the same sparse quota evidence; irrelevant statuses return
  false before reading history. The quota decision logic stays unchanged.
- crates/kybern-daemon/src/orchestrator/account_tests.rs: compare sparse target
  decisions to full replay after failures, resumes, later turns, unrelated events
  and binding transitions. Existing account/quota tests exercise continuation.
- apps/gpuix/perf/bench/seed.ts: own-daemon restart for truly cold projection-cache
  startup, preserving the fixture's synthetic live marker without orphan recovery
  changing its event sequence. No user's daemon is discovered or stopped.
- apps/gpuix/perf/bench/scenarios.ts: restore the realistic saved conversation;
  collect painted sidebar, first content and newest content for cold/warm and
  existing compiled-package starts. Warm mode primes its daemon once.
- apps/gpuix/perf/bench/model.ts and model.test.ts: expose median/p90 startup
  milestone tables in the benchmark report and verify report values.
- apps/gpuix/perf/bench/README.md: document these clocks, cold semantics and bundle
  override. apps/gpuix/perf/coldstart/: reusable fixture, packaging/build guards,
  fair quiet/UI leases, paired timings, diagnostics, resources and pixel checks.

- apps/gpuix/src/requests/accounts.ts: share normal in-flight account probes per
  daemon client; explicit refresh remains separate and every success/failure
  releases the slot. The weak-key map retains no completed account snapshots.
- apps/gpuix/src/composer/store.ts and src/usage/accounts.ts: consume the same
  pending probe and pass an already fetched account list to the composer instead
  of issuing another RPC. Environment-generation guards cover that handoff.
  Requests tests exercise overlap, fresh reads, explicit refresh, environment
  isolation and transport failure/retry.

Native patches: none. Product UI, font/atlas behavior, styles, motion and row keys
are unchanged. Page limits, sequence fences, live-event replay and history
prefetch remain unchanged.

## Experiments retained and dropped

Bounded replay alone fixed the contention mechanism but barely improved total
projection time; kept for sidebar responsiveness, then measured indexing
separately. Indexed-only five-pair evidence is retained in indexed-only/; it
improved cold open but left expensive quota-history reads, so it is not the final
acceptance candidate. Preliminary one-pair data is diagnostic, not a five-run
performance claim. A compile error binding usize as SQLite LIMIT was corrected
to u32; failed/retried logs are preserved. Account-request coalescing is a separate measured follow-up: store-only five-pair evidence is preserved in store-only/. It removes overlap between expensive account identity probes (about 1.2 seconds cold in the proxy trace) and avoids fetching the result again just to copy it into composer state. No speculative SQL index/migration,
raw-event-tail transcript truncation, new persistent cache, font rebuild or visual
simplification was adopted. Zed/Zeron's bounded work and stable identity approach
informed the temporary lookup design; their rendering systems were not ported.

## Final measurements

| Milestone (ms, median / p90; n=5 each) | Cold before | Cold after | Warm before | Warm after |
|---|---:|---:|---:|---:|
| Window / automation available | 505.3 / 636.4 | 515.5 / 1333.5 | 446.6 / 478.6 | 451.4 / 472.4 |
| Painted shell | 506.0 / 638.5 | 516.2 / 1337.3 | 456.9 / 489.0 | 460.9 / 486.6 |
| Sidebar painted | 1820.9 / 2403.9 | 1180.0 / 1824.1 | 1197.0 / 1210.8 | 664.1 / 688.2 |
| First saved content painted | 2640.7 / 2978.9 | 1996.3 / 2816.2 | 622.9 / 632.0 | 635.6 / 659.8 |
| Newest saved content painted | 2640.7 / 2978.9 | 1996.3 / 2816.2 | 622.9 / 632.0 | 635.6 / 659.8 |
| Older page RPC ready (from app spawn) | 3273.4 / 3446.9 | 2134.6 / 2935.7 | 1183.5 / 1186.2 | 790.4 / 800.4 |
| 2,000-turn open (from click) | 1036.1 / 1055.5 | 604.8 / 638.6 | 274.9 / 278.2 | 271.9 / 278.0 |
| Older content visible (from wheel start, includes travel) | 1666.2 / 1750.3 | 1652.8 / 1773.6 | 1734.2 / 1884.9 | 1744.1 / 1785.2 |
| History apply marks (1 ms resolution; 0 is below resolution) | 0.0 / 1.0 | 1.0 / 1.0 | 0.0 / 1.0 | 1.0 / 1.0 |

Cold sidebar median improves 35.2%; p90 2,403.9 → 1,824.1 ms, within the 1,830 ms target in this five-run set. Cold newest median improves 24.4%; cold 2,000-turn open improves 41.6%. Warm newest is 12.6 ms slower at median (622.9 → 635.6 ms) and 27.9 ms at p90; no warm-content speedup is claimed. These are CPU-paint polling upper bounds with 10 ms polling and a 60 Hz display, and five samples do not establish a guaranteed tail ceiling.

The cold candidate p90 window/shell includes one pre-entry process delay: first module at about 699 ms versus about 77 ms normally. All values include it; it was not discarded. Module import, endpoint, initial render/font, RPC and hydration phases are retained in each JSON. The separate app sample has 806 inclusive samples in GpuixRenderer::init / Application::run_embedded, confirming native initialization is substantial (diagnostic profiling changes timing). Font registration itself takes about 2–3 ms in ordinary traces; the several-hundred-ms initial native render precedes that mark. No unsupported attribution of all pre-render work to fonts is made.

| Scene submission intervals (ms) | p50 | p95 | p99 | >16.7 / >33 ms (count / intervals) |
|---|---:|---:|---:|---|
| baseline startup cold | 17.23 | 237.61 | 350.19 | 83 / 49 of 126 |
| baseline startup warm | 123.20 | 282.36 | 531.73 | 19 / 16 of 23 |
| baseline focused idle | 528.55 | 534.54 | 537.61 | 30 / 30 of 31 |
| baseline active scroll | 16.75 | 32.90 | 34.07 | 467 / 40 of 853 |
| candidate startup cold | 16.81 | 199.29 | 350.59 | 87 / 41 of 157 |
| candidate startup warm | 129.44 | 263.07 | 263.07 | 8 / 8 of 8 |
| candidate focused idle | 530.46 | 534.56 | 535.38 | 31 / 30 of 32 |
| candidate active scroll | 16.71 | 33.07 | 34.19 | 432 / 44 of 848 |

Startup gaps include data waits; focused idle gaps include the caret blink. They are not animation-drop counts. The active trace offers the same indexed contact/decay wheel deltas at 30 Hz: both variants delivered 454 packets during their 15.02 s sample. Actual overall rates were 29.9999 and 29.9995 Hz. Automation ACK p95 was 0.484 → 0.349 ms; ACK is not input-to-present latency.

| 10 s warm-up + 15 s sample, FULL_RATE=1 | App CPU % | App GPU ms/window | App footprint MiB | Daemon CPU % | Daemon footprint MiB |
|---|---:|---:|---:|---:|---:|
| baseline focused idle | 3.19 | 109.2 | 156 | 0.33 | 57 |
| baseline active scroll | 34.37 | 3100.6 | 169 | 0.33 | 65 |
| candidate focused idle | 3.06 | 116.4 | 158 | 0.33 | 40 |
| candidate active scroll | 35.09 | 3149.8 | 169 | 0.27 | 37 |

These are one resource sample per condition, not energy measurements or a GPU improvement claim. Active CPU changes +0.72 percentage points and GPU +49.2 ms/window (~1.6%); app footprint is unchanged at 169 MiB. Focused idle is 3.19 → 3.06% CPU, app footprint 156 → 158 MiB, daemon 57 → 40 MiB. The focused caret remains active (31 → 32 submissions); this lane does not claim zero-frame blurred idle.

| Active CPU work per sample (ms, p50 / p95 / p99) | Render | Layout |
|---|---|---|
| baseline | 4.00 / 4.76 / 4.99 | 0.53 / 0.92 / 1.08 |
| candidate | 4.14 / 4.78 / 5.07 | 0.56 / 0.96 / 1.14 |

Per-frame GPU cost inferred from the aggregate is about 3.64 → 3.71 ms/submission (not a fence-timed GPU frame profile). The display is 60 Hz; no 120 Hz hardware or input-to-photon certification is made. Tail intervals still exceed one display period and belong to the cadence/GPU follow-up, not this cold-start fix.

All 20 accepted timing runs were unlocked/awake before and after, had no build overlap, and committed 45 sidebar row bodies before the observed sidebar paint (0.9–26.2 ms earlier); no empty-list paint is credited. `acceptance-audit.json` records these checks. Cold startup account-list RPCs before first content fell from three to one in every candidate repeat; warm cached account reads remain cheap. Ten sequence-bounded RPC snapshots are exact matches.


## Visual and regression evidence

Evidence root: /Users/mymac/projects/ade/previews/gpuix/perf/coldstart/.
Dark/light before/after screenshots use identical deterministic transcript data.
The indexed-only visual batch was later discarded for zero/near-zero native submissions after the display slept; it is diagnostic only. Its light CPU capture also differed
only in the live Codex usage ring (949 pixels in x29–74/y1305–1350 of 2560×1640),
because real account usage changed between runs. Final visual-only proxy inputs
therefore supply fixed representative weekly usage (35% used) for both versions;
all actual rendering remains enabled and the whole image is compared. A subsequent light comparison isolated exactly 160 pixels (x878–881/y1405–1444) to the blinking insertion caret. Final visual runs blur the composer before settling, leaving product focus and caret behavior unchanged. Timing and
resource responses are never normalized.

## Remaining scope and limitations

No physical input-to-photon measurement or 120 Hz hardware guarantee. Render and
layout CPU cost are reported separately from submission cadence. Startup gaps
include waits for data and are not dropped animation frames. The focused empty composer’s inherited
roughly 0.5-second caret cadence remains visible; cadence and GPU lanes own its follow-up. The warm-newest +12.6 ms median and the one cold pre-entry window outlier are retained in the table; they are not hidden by the cold-content win.
The batch budget bounds transient event decoding, not the final projected
transcript retained by the existing cache. Latest-turn quota evidence excludes
message/tool bodies but can contain many usage events within an exceptionally
long single turn. SQLite still serializes each short read batch.

## Validation, provenance and cleanup

Rust validation: kybern-store 91 passed; kybern-daemon 552 passed, 6 ignored. Both touched crates pass clippy with all targets and -D warnings; workspace fmt check passes. GPUIX typecheck passes; latest bun test ./src: 334 passed, 6,883 assertions, including startup/history sequence replay and row identity. Benchmark tests: 9 passed. Benchmark and coldstart harness TypeScript checks pass. Latest benchmark model/telemetry/input tests pass. The user unlocked the session and acceptance resumed. Final five-pair timings, resource/input runs, both-theme visual comparison, benchmark smoke and both harness TypeScript checks pass. Dark and light each have zero changed pixels out of 4,198,400 (full image). Initial free disk: 82 GiB. Source commits remain in the
registered worktree; generated targets, bundles, scratch data/processes and
installed task dependencies have been removed after preserving evidence. The validated
native runtime pair is retained. No normal daemon/data, migration or native addon
was modified.

## Evidence index

- summary.json; baseline/candidate-timing-dark-{0..4}.json and matching native logs.
- acceptance-audit.json, environment.json (source/runtime hashes), display-audit.json, display-rejected.json.
- baseline/candidate-resources-dark-0.json; baseline/candidate-active-dark-0.json (raw samplers and offered input).
- baseline/candidate-visuals-{dark,light}-0.png; pixel-diff.json (zero full-image differences).
- baseline/candidate-profile-dark-0.{json,sample.txt,snapshots.json}; baseline/candidate-app-profile-dark-0.app-0.sample.txt.
- bench-smoke.json/.md and bench-smoke/ logs: cold, warm and packaged startup all pass and expose all requested paint milestones. These one-repeat smoke values are instrumentation validation, not the five-pair A/B.
- quota-build.log: 552 daemon tests passed / 6 ignored, 91 store tests passed, clippy, fmt and daemon build.
- account-build.log: typecheck, 334 source tests / 6,883 assertions, 9 benchmark tests, both harness typechecks, compiled candidate package. Final standalone harness typechecks are also preserved.
- preliminary-* (batch-only diagnostics), indexed-only/ and store-only/ (earlier candidates), headless-* (valid locked-session daemon diagnostics), rejected-display/ (invalid UI captures). Earlier data is never mixed into final summary.json.

Cleanup complete: initial free space 82 GiB (rounded original observation); final actual free space 80.18 GiB. Immediately before/after deletion it was 77.50 → 80.18 GiB on the shared APFS volume; do not attribute concurrent volume changes or nominal directory sizes entirely to this task. Removed the 2.4 GiB target, 188 MiB GPUIX + 633 MiB desktop disposable dependencies, 646 MiB compiled bundles, task scratch databases/backups and task-owned process/queue/marker state. No scratch app/daemon or open target/dependency/bundle files remained before deletion. There is no extra .cargo/target or native/build/target, and no Bun compiler temporary file.

Retained: the 25.4 MiB validated native addon/webview pair needed by this registered worktree, unchanged hash, and 78 MiB external evidence. Source/worktree registrations are intact. cleanup.json preserves paths, hashes and actual df output.

Branch: gpuix/perf-coldstart, from b14b10f1. Product commits: fbbda91a1 (bounded replay), bbd1a22e (temporary identity indexes), cab02771 (sparse quota evidence), d54e936d3 (shared account probes). Instrumentation commits: 89ec5cacd and 666e29b1e. The final report commit and clean-status verification are recorded in environment.json and the handoff message. No push or merge was performed.
