# Real-session memory — 2026-09-24

## Why this pass

The single-window follow-up asked for a long-session full-shell profile. This
pass adds one: `real-session` boots the shipped `src/main.tsx` (not a fixture
shell) in the native WKWebView under the production CSP, against a scratch
daemon that owns a **snapshot copy** of a real store, or a fresh thread fed by
a replay of a recorded Claude session. Each step samples `vmmap`, mounted DOM,
and the store's `retainedSize` by key; the run ends with WebKit's JavaScript
GC SPI and a resample to separate live heap from uncollected garbage.

Apple M1, macOS 27.0, 1440×900, installed v0.4.17 `kybernd` as the scratch
daemon. The store copy held 143 threads and 507,031 events. All values are
WebContent physical footprint in MiB unless stated; footprint noise between
identical runs is about ±10 MiB, dirty graphics is steadier.

## Attribution

Boot peaked at 337–384 MiB before any thread opened, with about 1,000 DOM
nodes. Disabling CSS animations (not transitions) brought the boot peak to
241–274. The entry animations stack blur filters: `chat-pane-enter` blurred
the whole 1184×854 Draft pane while its children ran `t-stagger-in` blur
entrances. The boot spike is transient; home idle settles at 110–120.

In an open thread, WebKit's compositing overlay showed a full-pane tiled layer
over the content area. It was the always-mounted `thread-drop-overlay`
(opacity 0) whose `thread-drop-target` has `backdrop-filter: blur(18px)` and a
transform. The sidebar's `.sidebar-surface-enter` kept a permanent
`will-change: opacity, transform` over its whole, taller-than-viewport list.
Hiding the preview-rail container or the sidebar scroll mask had no repeatable
effect; the closed Environment card measured 3–5 MiB and is left for later.

Store data is small and bounded. After 40 thread visits the retained
transcripts were 7–9 MiB by estimate, below the 16 MiB inactive budget. A
1 MiB budget control changed live WebKit Malloc after GC by 1 MiB (131.5 vs
130.5), so the inactive-transcript budget is **not** a RAM lever. WebKit
Malloc dirty rose from about 82 to 155–185 MiB over the first 15 visits and
then plateaued. A simulated memory-pressure event (diagnostic only; it is
system-wide) cut live bytes from 134 to 70 MiB and JIT code from 10.5 to
1 MiB. A plain GC recovered little, so much of that plateau is purgeable
code/cache and allocator slack that WebKit releases under real pressure.

## Changes

- `ChatPaneDropOverlay` mounts its preview only while a thread drag is in
  progress, then keeps it 200 ms for the 150 ms fade-out. Split views have one
  overlay per pane, so each pane stops holding the layer.
- `.sidebar-surface-enter` drops the persistent `will-change` and uses a
  `backwards` fill, so WebKit promotes the list only during its 160 ms entry.
- The Draft screen drops the redundant pane-level `chat-pane-enter` fade/blur;
  the headline, logo and composer keep their `t-stagger` entrance.

## Before/after

Three interleaved pairs against unmodified `main` source (`41ae3e2d`), real
store copy, boot + 8 s home idle + 8 thread visits per run:

| Metric | Control runs | Mean | Candidate runs | Mean |
| --- | --- | ---: | --- | ---: |
| Boot lifetime peak | 337.3 / 350.2 / 383.8 | 357.1 | 317.1 / 305.6 / 315.3 | 312.7 |
| Home idle | 115.7 / 114.9 / 120.8 | 117.1 | 111.2 / 108.4 / 111.1 | 110.2 |
| Visit mean, dirty graphics | 103.2 / 100.0 / 94.3 | 99.2 | 85.2 / 81.6 / 82.2 | 83.0 |
| Visit mean, footprint | 224.7 / 226.6 / 222.8 | 224.7 | 222.3 / 202.0 / 220.8 | 215.0 |

The graphics saving held in every pair. The footprint means overlap within
noise in one pair, so treat about 10 MiB as the per-window steady result and
16 MiB of graphics as the stable signal. Peaks after the eight visits
(338–400) were unchanged; that peak comes from history rendering, not these
layers. The fixture's idle-layer assertion fails on the control build with the
drop target named, and passes on the candidate.

## Long live follow

`KYBERN_PERF_REPLAY_JSONL` replays a Claude Code session transcript (here, a
copy of this investigation's own 95-tool session) through the real Claude
driver, store, socket and UI while the thread follows output. From fresh seeds,
three passes each:

| Source | After pass 1 / 2 / 3 | After GC | Live WebKit Malloc after GC |
| --- | --- | ---: | ---: |
| v0.4.17 | 175.0 / 185.6 / 184.9 | 190.6 | 95.6 MiB |
| `main` | 221.4 / 178.9 / 220.4 | 218.1 | 80.7 MiB |
| Candidate | 164.6 / 172.8 / 195.1 | 183.0 | 94.1 MiB |

None grew across passes. The fixture window can be treated as occluded, so
`main`'s hidden-window compaction sometimes released the transcript
(`blocks: 0` at some marks); compare these rows for growth, not as an A/B.

## Installed app observation

The installed v0.4.17 WebContent measured 405–600 MiB during this session,
with 265–269 MiB live WebKit Malloc at the last sample. `CGWindowList` showed
the visible "This Mac" window plus **three offscreen "Os-kdi" environment
windows** (two 1280×820, one 1×1), all served by that one WebContent process.
Each window runs a separate app instance, which the single-window fixtures
above do not reproduce. The replay does not explain the installed live heap;
the extra environment windows are the leading hypothesis and are unverified.

## Follow-up: sidebar marquee and thread-open spikes

A 40-thread run on the branch rested at 200–258 MiB with two peak-setting
moments: boot (282) and one thread whose visit added 60 MiB of lifetime peak.
`KYBERN_PERF_SESSION_THREADS=<control>,<target>` reproduced it (+68 to +77 MiB
in two runs). Hiding its one 736×921 table removed the increase. The table
block is already its own layer (~11 MiB per backing store). Removing its
scroller, borders, table layout or paint host did not change it. With a 6 s
settle the same visit measured 168–188 MiB instead of 237–254 at 1.5 s, so
most of the spike is transient first-paint graphics. RSS does not see those
surfaces.

Every sidebar title carried a permanent `will-change: transform` for the hover
marquee (29 layers), which also promoted ~40 overlapping hover-action overlays.
Removing it (the pan transition still promotes the label while it runs):

| Run | Home idle | Target visit settled | Lifetime peak |
| --- | ---: | ---: | ---: |
| Control 1 / 2 | 114.1 / 114.2 | — | 336.7 / 335.6 |
| Marquee fix 1 / 2 | 106.8 / 109.1 | 177.7 / 168.1 | 317.9 / 316.9 |

The fixture now also fails if an idle marquee label keeps a layer. The sidebar
scroll-fade mask, the preview-rail container and table display changes had no
repeatable effect.

## Limits

WebContent only; the Tauri shell, daemon, GPU/networking processes and
WindowServer are excluded. The GC SPI and `notifyutil -p org.WebKit.lowMemory`
are diagnostics and must not ship. The store copy was read with `sqlite3
.backup`; the scratch daemon never touched `~/.kybern`.

## Reproduce

```sh
cd apps/desktop
# Snapshot of a real store (the runner copies it; the source stays read-only)
KYBERN_PERF_DAEMON_BINARY=/Applications/kybern.app/Contents/MacOS/kybernd \
KYBERN_PERF_SESSION_STORE=$HOME/.kybern/state.sqlite KYBERN_PERF_HISTORY=8 \
KYBERN_PERF_WIDTH=1440 KYBERN_PERF_HEIGHT=900 KYBERN_PERF_TIMEOUT=900 \
KYBERN_PERF_MEMORY_DIR=/tmp/real-session node scripts/check-rendering.mjs real-session

# Replay of a recorded Claude session while following the thread
KYBERN_PERF_REPLAY_JSONL=/path/to/session-copy.jsonl KYBERN_PERF_REPLAY_PASSES=3 \
  ... node scripts/check-rendering.mjs real-session
```

`KYBERN_PERF_MEMORY_DIR` keeps each stage's full `vmmap -summary`.
