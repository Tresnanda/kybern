# Whole-app live-result memory check

Date: 2026-09-18

Runtime: release Tauri shell at `tauri://localhost`, system WebKit on macOS 27,
1440 × 900 logical pixels, translucent window material unchanged

Machine: Apple Silicon Mac (the local development machine)

## Result

The complete desktop process coalition can reach the reported 800 MiB range
during a short burst of real tool results even though the settled transcript is
virtualized. In the quiet pair below, the baseline coalition peaked at 836.5
MiB and the candidate at 875.2 MiB while 64 results were arriving. Peak memory
did not improve; it is transient allocation capacity and must not be presented
as a saving.

The candidate did retain materially fewer dirty and allocated WebKit bytes after
the burst. Thirty seconds after the turn began, the candidate coalition was
391.8 MiB versus 440.1 MiB baseline. At the matched 100-second observation it
was 348.9 MiB versus 401.2 MiB. The candidate WebContent process was 49.5 MiB
lower at both observations. At its final 140-second observation it scavenged a
further 44 MiB, while the baseline did not; allocator timing makes that later
gap unsuitable as a universal claim.

The pair also began 60.2 MiB apart before the live turn (268.4 MiB baseline,
208.2 MiB candidate). Normalizing each later reading to its own pre-turn value
does not show a physical-footprint reduction at 30 or 100 seconds. Therefore
this one whole-app pair is corroborating retention evidence, not a reproducible
percentage improvement. The deterministic retained-payload check and source
invariant are the proof of the bounded live-result change.

## Builds and isolation

Both apps were release bundles with production CSP, the shipping translucent
material, identical window geometry, and the same sidecar binary:

| Build | Source | Bundle ID | Shell SHA-256 |
| --- | --- | --- | --- |
| Baseline | immediately before live-result enrollment | `dev.kybern.memory-profile.livebase1` | `451cdb43ea6d509fd56d01c3f253672685c289b7c1efcffee6aa888aea071f24` |
| Candidate | live-result cache commit `6df574191dc772ef938b5dd69fd285432915a27b` (local cherry-pick `485ecbd4`) | `dev.kybern.memory-profile.livecandidate1` | `d42f84dff2d9291f35ea68fe2671fa00e2fbd9a95b3f7ad44759ea0cff4275ae` |

Both sidecars had SHA-256
`2d973c8e3a780f25cc26741382ba170b01844cfb83a927ddd3212c5e70cdf4bb`.
The configs in this directory preserve the shipping effect and differ only in
their compiled identifiers. Data and client registries lived below
`perf-artifacts/whole-app-ram-20260918/.scratch`; production data was never
opened by either scratch app.

The release Tauri builds completed successfully, including `tauri-macros`.
The final parent review identified the debug-only `E0463` more precisely:
macOS rejected the stripped `tauri_macros` dylib with `mis-aligned LINKEDIT
string pool`. Two other feature variants loaded successfully. This matches
[Rust issue 157750](https://github.com/rust-lang/rust/issues/157750); the local
dev profile now disables stripping only for that build-time proc-macro. It is
not a Tauri API incompatibility or an application RAM regression.

The installed GUI was closed through normal application termination only. Its
daemon remained PID 3816 with start identity `Fri Sep 18 15:18:25 2026`
throughout. After the pair, `/Applications/kybern.app` was reopened and the
same daemon identity was verified. No production process was killed or
replaced.

## Workload and process attribution

`seed-whole-app-memory.py` creates two scratch threads. The active thread has
400 settled turns, 800 saved tool calls, Markdown tables, code and Unicode; the
secondary thread is present as an ordinary navigation target. The actual
daemon then launches the deterministic offline Claude-compatible driver for
`PROFILE_LIVE_TOOLS`. That turn emits 64 closed `Read` results, each 1,179,663
characters (75,498,432 characters total), through the real driver, daemon,
SQLite event store, WebSocket subscription and React transcript.

The baseline and candidate databases each contained all 64 completions. Ordered
result contents had the same SHA-256:
`0e61a571a0cec0ecb4a3fa0aaeab5d5925d61a9e503999858d856322c084eea4`.
Screenshots show the same final Unicode table (`é😀`), final message, closed work
disclosure and file-change card. Nothing was hidden, truncated or reformatted
to obtain the memory reading.

`profile-tauri-coalition.py` sampled every 500 ms using kernel process-start
identity and the shell's resource coalition. It included only the exact shell,
its sidecar daemon and its WebKit WebContent/GPU/Networking services:

| Build | Shell | Daemon | WebContent | GPU | Networking | Coalition |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 94531 | 94836 | 94535 | 94534 | 94536 | 17339 |
| Candidate | 96455 | 96740 | 96461 | 96460 | 96462 | 17393 |

Unrelated WebKit helpers, scratch fixtures and the installed application were
not counted. A first baseline launch revealed that a deliberately preserved
scratch daemon had become orphaned from the relaunched shell coalition; that
launch was discarded. Only the clean attributed restart above enters the
comparison.

## Physical footprint timeline

All values are physical footprint in MiB (2^20 bytes). `+N s` is relative to
the start of the live-result phase.

| Stage | Baseline coalition | Candidate coalition | Baseline WebContent | Candidate WebContent |
| --- | ---: | ---: | ---: | ---: |
| Stable history before live turn | 268.4 | 208.2 | 203.3 | 145.7 |
| Burst peak | 836.5 | 875.2 | 731.9 | 738.5 |
| +25 s | 454.4 | 391.7 | 339.4 | 275.6 |
| +30 s | 440.1 | 391.8 | 325.3 | 275.6 |
| +100 s | 401.2 | 348.9 | 325.1 | 275.6 |
| +140 s | 401.1 | 304.8 | 325.1 | 231.5 |

The peaks occur while ~75.5 million result characters are constructed,
serialized, stored and delivered. The candidate deliberately does not attempt
to eliminate that transient work. It prevents all 64 completed payload objects
from remaining strongly owned by the active transcript after settlement.

## WebKit allocator evidence

`vmmap -summary` was captured from the attributed WebContent PID after live
settlement and after idle:

| Observation | Footprint | WebKit Malloc dirty | Zone allocated | Allocation count |
| --- | ---: | ---: | ---: | ---: |
| Baseline settled | 325.1 MiB | 241.1 MiB | 219.6 MiB | 357,161 |
| Candidate settled | 275.6 MiB | 147.9 MiB | 128.6 MiB | 366,599 |
| Baseline idle | 325.1 MiB | 241.2 MiB | 219.6 MiB | 357,318 |
| Candidate idle | 231.5 MiB | 102.9 MiB | 80.9 MiB | 337,794 |

The candidate has more allocator entries at the settled capture but about 91
MiB fewer allocated bytes. That direction matches removal of large retained
result strings rather than removal of UI nodes or native materials. WebKit kept
larger virtual/resident allocator capacity in the candidate run, another reason
not to infer savings from one high-water sample alone.

Raw evidence lives outside the repository at
`/Users/mymac/projects/ade/perf-artifacts/whole-app-ram-20260918/`:
`baseline-samples.jsonl`, `candidate-samples.jsonl`, four vmmap summaries and
the baseline/candidate screenshots.

## Native and store lifecycle review

- Environment disconnect clears snapshot maps, history loads, the reusable
  snapshot cache and the result cache, compacts transcript data, aborts uploads
  and closes the socket. Switching stores also compacts the outgoing store.
- `environmentStores` intentionally retains one compact store for every visited
  environment until that environment is removed. This is bounded by visited
  profiles, but it is process-lifetime state. If ordinary long-session memory
  still grows after this fix, instrumenting that map and deleting disconnected
  stores after a safe grace period is the next defensible frontend lifecycle
  experiment. It is not the source of the active-thread result retention above.
- Each open terminal owns a 5,000-line xterm scrollback. Hidden terminals release
  their WebGL renderer; closing/unmounting disposes subscriptions, renderer and
  terminal. The scrollback is intentional bounded mixed-session state, not an
  unbounded cache.
- Each separate environment window is a real `WebviewWindow`, so it correctly
  owns another WebContent process while open. The application does not keep a
  parallel Rust registry of closed window objects. The traffic-light settle
  thread runs only 24 × 120 ms; it is not a process-lifetime worker.
- The native material remains enabled in this comparison. The opaque preference
  now clears its effect view, but that separate change must not be credited for
  the live-result result.

## Limitations

This is one serialized before/after pair on one machine. It deliberately avoids
parallel compilers and native fixtures, but macOS/WebKit allocator scavenging,
compression and graphics residency still vary. The candidate's higher transient
peak and the unequal pre-turn baselines demonstrate that variance.

The workload covers cold persisted history plus a real live driver/daemon/store
turn, which is the retained structure under test. It does not cover hours of
ordinary use, multiple simultaneously open environment windows, terminal
scrollback, image decoding, CPU, energy or WindowServer memory. Accessibility
input injection was unavailable, so pane switching and synthetic manual
scrolling were not added to this pair; doing so after seeing the first result
would have made the two runs less comparable.

The result does not establish a universal whole-app cap and does not by itself
prove that every reported 800 MiB observation had this cause. It does establish
that an ordinary active thread could retain tens of megabytes of completed live
outputs outside the saved-result cache, and that the bounded candidate preserves
their exact durable contents while materially reducing WebKit's settled allocated
bytes in this controlled run.
