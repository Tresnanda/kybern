# GPUIX memory in real sessions (memlog, 2026-10-23)

The installed 0.11.1 app showed 880 → 727 MB in Activity Monitor after 8.4 h, with a
**1,105 MB peak**. `footprint`: 459 MB `App-Specific Tag 1` (the JS side: JSC and Bun's
allocator), 52 MB IOSurface, 61 MB IOAccelerator. Native object counts were normal
(the autorelease leak fixed in `../ramfix` stays fixed), and the footprint was flat
while idle.

## The memory log

`src/perf/memoryLog.ts` writes one JSON line a minute to `memory.jsonl` in the client
config folder (`~/Library/Application Support/kybern-gpuix`, 4 MiB, one rotated copy):
physical footprint and peak, RSS, JSC heap/capacity/external, each pane's thread,
block count and transcript size, and the thread opens and history pages since the
previous line. After a JS heap jump of 96 MB it adds an object-type census (a heap
walk, at most once every 15 minutes). `KYBERN_MEMORY_LOG=0` turns it off.

## What the spikes were

`real.ts` runs the full app against a scratch daemon serving a stripped copy of the
real store (idle threads, no provider sessions, `env -i` daemon). Opening the five
heaviest threads and loading all their history (up to 7,647 blocks) peaked at 265 MB.
Replaying the orchestrator thread that was open all night (`KYBERN_MEMLOG_REPLAY`:
6,257 events streamed through `applyEvent` → `setThreadOpen` as if live) peaked at
**594–728 MB**, outside the JS heap: the addon's large allocations rose to 100–210 MB
while each reply streamed and fell when it completed.

`MallocStackLogging=lite` at a spike (`KYBERN_MEMLOG_SNAPSHOT_MB`) put 132 MB in
`gpui::platform::decode_static_image` → `into_rgba8`: three full-size decodes in
flight. The replies embed screenshots up to 2880×1800 (20.7 MB of pixels each, about
44 MB while decoding) for a 280 pt slot. They arrived as base64 `data:` URLs, which
also became the native image cache's key strings, and the 16 MB dormant budget evicted
and re-decoded them as the streaming reply re-rendered (56 evictions per replay).
With `KYBERN_STREAM_DOCUMENT=0` the spikes were unchanged, so the streaming Markdown
document is not involved. Ten-round soak replays showed no growth between rounds.

## The fix

`src/transcript/imageFiles.ts`: every `ResponseImage` paints from a file. `data:` URLs
and daemon-fetched bytes are written once per content hash, local files are used in
place, and a copy at most twice the slot wide is made with `sips` (two at a time). The
lightbox and image tabs open the original. The cache folder is pruned to 256 MB at
launch. `KYBERN_IMAGE_FILES=0` restores the old path.

| Orchestrator replay | Peak footprint | Large allocations, max | After, at Home |
|---|---:|---:|---:|
| before (3 runs) | 620 / 673 / 728 MB | 172–211 MB | 264–274 MB |
| after | **308 MB** | **25 MB** | 258 MB |

The image-check thread (three screenshots and an attachment): 342 MB → 237 MB with
the thread open, 344 → 279 MB with the lightbox open. Inline images are sharper than
before (ImageIO resampling instead of GPU minification); the lightbox is full
resolution.

The 459 MB after 8 hours came from live turns instead (see the live-turn leak below).

## A normal session on this branch (with the image fix)

`session.ts`, a stripped copy of the real store: 12 of the day's threads opened in turn
with three history pages each, the orchestrator streamed in process, six document tabs
(code, Markdown, diff, image), then Home and a minute idle.

| Phase | Footprint | Peak | Tag 1 | Live JS heap (after full GC) |
|---|---:|---:|---:|---:|
| Home | 221 | 242 | 112 | 24 |
| 12 threads | 251 | 266 | 126 | — |
| Streamed | 283 | 308 | 138 | 41 |
| Six tabs open | 348 | 359 | 136 | 38 |
| Home, idle | **294** | 359 | 130 | 29 |

The live JS heap stays at 24–41 MB; transcripts, Markdown caches and the file cache are
not the large retainers.

## The live-turn leak: development React (fixed)

The installed app grew from 459 to 554 MB in `App-Specific Tag 1` in one hour of live
agent turns and stayed flat while nothing streamed. `live.ts` reproduces it through the
real path: the scratch daemon's Claude binary is `apps/desktop/scripts/profile-replay-driver.py`
(settings `providers.claude-code.binary`, `KYBERN_PERF_REPLAY_JSONL` on the daemon), so
each `PROFILE_REPLAY` message streams a recorded session through the driver, store and
WebSocket while the app watches the thread. `real.ts` with `KYBERN_MEMLOG_LAST` and
`KYBERN_MEMLOG_ROUNDS` reproduces it in process, without the daemon.

Cause: the packaged app ran React's development build. `scripts/package-app.ts` never
defined `NODE_ENV`, so the bundle kept `react-reconciler.development.js` (9
`performance.measure` call sites; 0 with the define). React 19.2's development build
records a `performance.measure` entry for every component it renders, and nothing
clears them; each streamed token re-renders rows. A heap snapshot after three replays
held 46 MB in the `Performance` object and 2,578 owner-stack `Error`s. The entries live
in Bun's allocator, so the GC'd heap (24–41 MB) never showed them.

Fix: `package-app.ts` defines `process.env.NODE_ENV` as `production`. A development run
(`bun src/main.tsx`) clears the entries every 10 s (`main.tsx`). Nothing in the app reads
them.

| Live passes, window painting | Tag 1 (dev → production) | Footprint (dev → production) |
|---|---:|---:|
| open | 115 → 111 | 215 → 214 |
| after pass 1 | 213 → 139 | 356 → 273 |
| after pass 2 | 271 → 146 | 415 → 292 |
| after pass 3 | — → 149 | — → **299** |

In process, three rounds of one pass: dev 117 → 146 → 197 → 347; production 104 → 134 →
162 → 161, 295 MB footprint idle.

What it was not (each measured): the WebSocket client (`socket.ts`: 11,085 events, flat),
the native streaming-document API (`doc-churn.ts`: 12,350 updates, flat), RPC traffic
(about 95 KB a pass), and the addon's private mimalloc (`KYBERN_MEMLOG_TAG1_STACKS=1`: the
growing regions are Bun's own 128 MB reservations). The growth needs painted frames:
with the display asleep, or with a document tab covering the chat, nothing grows.

Still open: transient peaks of 406–470 MB while a pass streams (the replay is faster than
a real agent), and the heavy fixture (`perf/ramfix/retained.ts`) on this branch.

## Running

```sh
D=/Users/mymac/projects/ade-gpuix-scratch/memlog-real   # stripped store copy + `env -i` daemon on :4391
export KYBERN_DATA_DIR=$D NAPI_RS_NATIVE_LIBRARY_PATH="/Applications/Kybern GPUIX.app/Contents/Resources/gpuix-native.darwin-arm64.node"
bun perf/memlog/real.ts open <thread> [thread ...]           # open, all history, visit, Home
KYBERN_MEMLOG_REPLAY=<thread> bun perf/memlog/real.ts replay  # stream it back; KYBERN_MEMLOG_ROUNDS for a soak
KYBERN_IMAGE_FILES=0 bun perf/memlog/images-check.ts before <thread>   # thread and lightbox captures
bun perf/memlog/session.ts <label> <streamed thread> <thread ...>      # the normal session above
bun perf/memlog/live.ts <label> <thread> [passes] [minutes]           # live turns via the replay binary
bun perf/memlog/socket.ts <raw|fold> <thread> [passes]                # the same, client only
bun perf/memlog/doc-churn.ts <reply.md> [rounds] [replies] [step]     # native streaming documents, no painting
```

Before running a daemon on a copy of the real store, delete every thread you do not
need, clear `provider_session_id`, and start it under `env -i HOME=<scratch> PATH=/usr/bin:/bin`;
check `pgrep -P <daemon>` is empty.
