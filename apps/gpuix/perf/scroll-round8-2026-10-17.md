# PR scroll geometry — round 8

Status: partial against the literal frame target. The native backlog/layout fixes pass the synthetic input and pixel checks below. Physical-trackpad hands-on acceptance remains unverified; submission p95 exceeds a strict 16.7 ms cutoff.

## Workload and methods

Apple M1, macOS 27, Bun 1.4.0, GPUIX 0.10.0. KYBERN_FULL_RATE=1, KYBERN_FRAME_COSTS=1, KYBERN_FRAME_TIMES=1. The same rebuilt addon is compared with KYBERN_SCROLL_LAYOUT=0 + KYBERN_SCROLL_COALESCE=0 (before) and layout=1 + coalesce=pr + KYBERN_SCROLL_ISLANDS=1 (after), with islands=0 before, while KYBERN_INPUT_FRAME_DRAW=0. Native values are submission intervals and CPU render/layout work, not physical presentation fences. No screenshots or manual clocks are used in timing runs.

Each scene warms for 10 s and receives 1,800 precise pixel RPC wheel packets scheduled at 120 Hz over 15 s. The profile alternates direction every 2.5 s, with a 1 s contact ramp followed by 1.5 s exponential synthetic momentum. Production is pipelined so frame work cannot silently throttle the offered rate; results retain actual offered duration, acknowledgement times, maximum outstanding requests and drain time. The patched automation API sends native Started/Moved/Ended markers for each contact/momentum segment. GPUI exposes no separate momentum flag. Browser input cannot set these phases. This approximates packet rate and delta decay, not a physical trackpad or OS event coalescing.

Fixture: 30 PRs, a 40-section formatted Summary, 30 files containing 2,400-line patches (bounded expansion), and 30 review entries. Process samples use perf/sample.ts for 15 s after warm-up. CPU is one-core percentage; GPU is AGX process GPU-time, not utilization or energy. Daemon and WindowServer are excluded; differences below about three CPU points are noise.

The reference is the actual desktop frontend in Playwright WebKit 2336, not a native Tauri host. It receives the same 120 Hz packet schedule through page.mouse.wheel. Native RPC acknowledgements and browser rAF timings are different stages. Native dispatch→CPU-paint probes start after entry into GPUI and end after scene construction; they exclude transport/OS queue time and GPU presentation. RPC acknowledgement includes transport queue time but precedes the deferred paint. Both are reported, along with outstanding depth and time from the last offered packet to the final CPU paint. Offered→CPU-paint receipt matches native batch packet counts to the FIFO producer only when all 1,800 timed packets are accounted for; a warm-up overlap or clamped/no-paint packet invalidates that estimate and produces a dash. Pipe delivery adds a small observation delay. The unrelated-next-submission probe remains in raw data for diagnosis and must not be called input latency. Native interval/cost statistics include any drain period; resources cover the first 15 s after warm-up. The native accumulator retains exactly one pending slot, with packet count as telemetry rather than a queue of events.

## Frame intervals

| Mode | Scene | Before p50/p95 ms | After p50/p95 ms | WebKit p50/p95 ms |
|---|---|---|---|---|
| dark/normal | list | 16.66/17.04 | 16.64/17.69 | 17.00/18.00 |
| dark/normal | summary | 16.27/17.50 | 16.67/17.51 | 17.00/18.00 |
| dark/normal | changes | 16.67/16.74 | 16.66/17.31 | 17.00/18.00 |
| dark/normal | timeline | 16.67/16.75 | 16.67/17.40 | 17.00/17.00 |
| dark/reduced | list | 16.86/17.48 | 16.75/18.57 | 17.00/19.00 |
| dark/reduced | summary | 16.08/17.96 | 16.67/18.76 | 17.00/19.00 |
| dark/reduced | changes | 16.66/16.82 | 16.79/18.64 | 17.00/19.00 |
| dark/reduced | timeline | 16.67/16.78 | 16.68/18.77 | 17.00/18.00 |
| light/normal | list | 16.86/17.86 | 16.64/17.49 | 17.00/18.00 |
| light/normal | summary | 15.94/17.19 | 16.67/16.88 | 17.00/18.00 |
| light/normal | changes | 16.67/16.79 | 16.65/17.10 | 17.00/18.00 |
| light/normal | timeline | 16.67/16.76 | 16.66/17.27 | 17.00/18.00 |
| light/reduced | list | 16.67/16.73 | 16.60/18.80 | 17.00/18.00 |
| light/reduced | summary | 17.07/25.52 | 16.66/17.51 | 17.00/33.00 |
| light/reduced | changes | 16.67/16.79 | 16.66/17.70 | 33.00/34.00 |
| light/reduced | timeline | 16.67/18.26 | 16.66/16.94 | 17.00/18.00 |

## Input backlog and latency

| Mode | Scene | Variant | RPC outstanding max | RPC ack p50/p95 ms | ACK drain ms | CPU paint drain ms | Native dispatch→paint p50/p95 ms | Offered→CPU-paint receipt p50/p95 ms (matched packets) | Merged packets max |
|---|---|---|---:|---|---:|---:|---|---|---:|
| dark/normal | list | before | 1 | 3.54/3.91 | 0.14 | 0.00 | 3.37/3.68 | 3.43/3.76 (1800) | 1 |
| dark/normal | summary | before | 1060 | 12873.19/17014.41 | 14405.46 | 14404.51 | 15.87/16.71 | 7168.00/13704.59 (1800) | 1 |
| dark/normal | changes | before | 1288 | 11767.68/20717.38 | 14992.88 | 14988.84 | 13.62/14.11 | 7505.82/14255.21 (1800) | 1 |
| dark/normal | timeline | before | 54 | 142.79/311.36 | 235.56 | 235.23 | 6.89/7.46 | 109.44/223.86 (1800) | 1 |
| dark/normal | list | after | 1 | 0.13/3.32 | 0.14 | 6.55 | 16.22/17.36 | 11.31/19.90 (1800) | 3 |
| dark/normal | summary | after | 2 | 0.28/2.39 | 0.16 | 6.18 | 16.26/17.11 | 16.10/18.63 (1800) | 3 |
| dark/normal | changes | after | 1 | 1.98/4.15 | 0.11 | 6.39 | 16.32/16.96 | 18.37/20.44 (1800) | 2 |
| dark/normal | timeline | after | 2 | 0.18/6.03 | 0.10 | 11.96 | 16.27/16.96 | 14.36/22.23 (1800) | 3 |
| dark/reduced | list | before | 2 | 3.57/4.00 | 0.16 | 0.00 | 3.31/3.65 | 3.38/3.76 (1800) | 1 |
| dark/reduced | summary | before | 1300 | 11232.63/16132.79 | 14139.69 | 14139.02 | 15.68/16.75 | 7213.42/13475.61 (1800) | 1 |
| dark/reduced | changes | before | 1149 | 11815.26/18404.38 | 14439.46 | 14435.63 | 13.46/13.78 | 6950.92/13701.50 (1800) | 1 |
| dark/reduced | timeline | before | 12 | 68.78/93.68 | 43.38 | 43.14 | 6.76/7.10 | 50.29/52.51 (1800) | 1 |
| dark/reduced | list | after | 2 | 0.16/6.01 | 0.24 | 10.43 | 16.26/18.01 | 15.43/23.33 (1800) | 3 |
| dark/reduced | summary | after | 1 | 0.14/2.37 | 0.12 | 5.23 | 16.26/18.34 | 15.14/18.91 (1800) | 2 |
| dark/reduced | changes | after | 2 | 0.13/6.10 | 0.17 | 8.25 | 16.36/18.18 | 15.63/23.47 (1800) | 3 |
| dark/reduced | timeline | after | 2 | 0.17/6.14 | 0.21 | 11.11 | 16.27/18.37 | 15.50/23.29 (1800) | 3 |
| light/normal | list | before | 1 | 3.73/4.12 | 0.15 | 0.00 | 3.50/3.81 | 3.57/3.90 (1800) | 1 |
| light/normal | summary | before | 1071 | 10902.12/16370.83 | 13746.24 | 13745.33 | 15.56/15.97 | 6869.44/13068.53 (1800) | 1 |
| light/normal | changes | before | 1288 | 11767.01/20717.35 | 14991.55 | 14987.39 | 13.47/13.84 | 7503.84/14253.50 (1800) | 1 |
| light/normal | timeline | before | 4 | 19.60/27.67 | 10.27 | 10.11 | 6.75/7.03 | 16.52/17.95 (1800) | 1 |
| light/normal | list | after | 1 | 0.11/3.19 | 0.14 | 0.00 | 11.93/16.96 | 11.59/19.74 (1800) | 3 |
| light/normal | summary | after | 6 | 3.68/7.69 | 0.13 | 12.16 | 14.04/16.42 | 19.39/21.71 (1800) | 5 |
| light/normal | changes | after | 1 | 0.22/1.69 | 0.16 | 8.62 | 16.34/16.77 | 16.10/18.03 (1800) | 2 |
| light/normal | timeline | after | 1 | 0.34/4.02 | 0.22 | 11.33 | 16.29/16.90 | 16.19/20.29 (1800) | 2 |
| light/reduced | list | before | 1 | 3.53/3.89 | 0.13 | 0.00 | 3.37/3.71 | 3.43/3.77 (1800) | 1 |
| light/reduced | summary | before | 1472 | 14961.20/20780.02 | 17857.57 | 17856.48 | 16.62/24.80 | 10043.00/17095.59 (1800) | 1 |
| light/reduced | changes | before | 1224 | 14053.57/19653.05 | 14743.05 | 14740.03 | 13.41/13.74 | 7255.63/14006.30 (1800) | 1 |
| light/reduced | timeline | before | 500 | 1812.85/4847.28 | 3460.07 | 3459.21 | 8.39/9.01 | 1179.12/3269.36 (1800) | 1 |
| light/reduced | list | after | 2 | 0.47/5.25 | 0.34 | 12.16 | 16.19/18.23 | 14.22/21.40 (1800) | 3 |
| light/reduced | summary | after | 1 | 0.86/5.16 | 0.10 | 9.25 | 16.20/17.04 | 16.57/21.25 (1800) | 2 |
| light/reduced | changes | after | 2 | 0.13/7.09 | 0.19 | 9.38 | 16.15/17.16 | 15.68/23.50 (1800) | 3 |
| light/reduced | timeline | after | 1 | 4.32/5.68 | 0.21 | 10.56 | 14.56/15.54 | 15.42/20.54 (1800) | 2 |

## Native work and resources

Uncached calls are layout API calls minus geometry-reuse hits; they are an upper bound on flex-solver calls because GPUI can also reuse an already-computed root within the same frame.

| Mode | Scene | Cache | Render p50/p95 ms | Layout p50/p95 ms | Layout API / uncached calls p50 | Reused roots/nodes p50 | CPU % | GPU ms/15 s | MiB | Offered Hz | Drain ms |
|---|---|---|---|---|---:|---|---:|---:|---:|---:|---:|
| dark/normal | list | before | 3.36/3.66 | 1.26/1.44 | 13/13 | 0/0 | 45.34 | 849.0 | 210.0 | 120.00 | 0.14 |
| dark/normal | summary | before | 15.85/16.68 | 11.50/11.97 | 34/34 | 0/0 | 101.80 | 1311.3 | 222.0 | 120.00 | 14405.46 |
| dark/normal | changes | before | 13.59/14.09 | 8.79/8.98 | 55/55 | 0/0 | 85.97 | 2745.8 | 240.0 | 120.00 | 14992.88 |
| dark/normal | timeline | before | 6.87/7.44 | 3.56/3.69 | 35/35 | 0/0 | 86.84 | 1717.4 | 240.0 | 120.00 | 235.56 |
| dark/normal | list | after | 2.67/3.16 | 0.32/0.77 | 15/3 | 12/597 | 21.54 | 1186.7 | 216.0 | 120.00 | 0.14 |
| dark/normal | summary | after | 4.51/5.47 | 0.73/0.89 | 25/23 | 2/1454 | 34.24 | 1580.5 | 226.0 | 120.00 | 0.16 |
| dark/normal | changes | after | 4.12/4.61 | 0.84/1.11 | 35/3 | 32/565 | 30.59 | 2466.7 | 251.0 | 120.00 | 0.11 |
| dark/normal | timeline | after | 5.09/5.67 | 0.88/0.99 | 26/21 | 5/373 | 36.38 | 1643.1 | 253.0 | 120.00 | 0.10 |
| dark/reduced | list | before | 3.29/3.63 | 1.22/1.37 | 13/13 | 0/0 | 45.21 | 1147.3 | 204.0 | 120.00 | 0.16 |
| dark/reduced | summary | before | 15.66/16.73 | 11.43/11.90 | 34/34 | 0/0 | 101.93 | 1207.3 | 220.0 | 119.99 | 14139.69 |
| dark/reduced | changes | before | 13.44/13.76 | 8.87/9.13 | 55/55 | 0/0 | 87.10 | 2741.3 | 234.0 | 120.00 | 14439.46 |
| dark/reduced | timeline | before | 6.74/7.08 | 3.57/3.72 | 35/35 | 0/0 | 85.44 | 1819.3 | 235.0 | 119.99 | 43.38 |
| dark/reduced | list | after | 5.18/6.09 | 0.65/1.53 | 15/3 | 12/597 | 38.25 | 1604.1 | 206.0 | 120.00 | 0.24 |
| dark/reduced | summary | after | 5.61/5.88 | 0.94/0.99 | 25/23 | 2/1454 | 39.42 | 1769.8 | 219.0 | 120.00 | 0.12 |
| dark/reduced | changes | after | 5.58/5.94 | 1.20/1.48 | 35/3 | 32/565 | 38.82 | 2734.3 | 230.0 | 120.00 | 0.17 |
| dark/reduced | timeline | after | 5.43/5.82 | 0.90/1.03 | 26/21 | 5/373 | 38.86 | 1734.9 | 232.0 | 119.99 | 0.21 |
| light/normal | list | before | 3.48/3.79 | 1.29/1.51 | 13/13 | 0/0 | 46.67 | 1242.5 | 212.0 | 120.00 | 0.15 |
| light/normal | summary | before | 15.54/15.95 | 11.40/11.56 | 34/34 | 0/0 | 101.68 | 1228.5 | 223.0 | 119.99 | 13746.24 |
| light/normal | changes | before | 13.45/13.82 | 8.83/9.06 | 55/55 | 0/0 | 85.05 | 2763.9 | 234.0 | 119.99 | 14991.55 |
| light/normal | timeline | before | 6.73/7.01 | 3.56/3.69 | 35/35 | 0/0 | 85.37 | 1821.0 | 234.0 | 120.00 | 10.27 |
| light/normal | list | after | 2.66/3.20 | 0.31/0.77 | 15/3 | 12/597 | 21.28 | 1193.6 | 201.0 | 120.00 | 0.14 |
| light/normal | summary | after | 5.60/5.96 | 0.93/0.98 | 25/23 | 2/1454 | 38.95 | 1804.4 | 211.0 | 120.00 | 0.13 |
| light/normal | changes | after | 5.58/6.00 | 1.27/1.54 | 35/3 | 32/565 | 38.95 | 2721.2 | 227.0 | 120.00 | 0.16 |
| light/normal | timeline | after | 5.36/5.86 | 0.89/1.03 | 26/21 | 5/373 | 38.13 | 1675.3 | 228.0 | 120.00 | 0.22 |
| light/reduced | list | before | 3.36/3.69 | 1.26/1.43 | 13/13 | 0/0 | 45.34 | 912.5 | 205.0 | 120.01 | 0.13 |
| light/reduced | summary | before | 16.60/24.77 | 12.18/18.27 | 34/34 | 0/0 | 101.72 | 1086.6 | 227.0 | 120.00 | 17857.57 |
| light/reduced | changes | before | 13.39/13.71 | 8.81/9.07 | 55/55 | 0/0 | 85.25 | 2751.1 | 232.0 | 120.00 | 14743.05 |
| light/reduced | timeline | before | 8.37/8.98 | 4.25/4.53 | 35/35 | 0/0 | 86.00 | 1713.6 | 234.0 | 119.99 | 3460.07 |
| light/reduced | list | after | 6.20/8.15 | 0.77/1.79 | 15/3 | 12/597 | 46.44 | 2098.6 | 203.0 | 120.01 | 0.34 |
| light/reduced | summary | after | 6.46/7.38 | 1.07/1.24 | 25/23 | 2/1454 | 45.86 | 2212.0 | 217.0 | 120.00 | 0.10 |
| light/reduced | changes | after | 6.64/7.36 | 1.54/1.87 | 35/3 | 32/565 | 46.33 | 3491.5 | 227.0 | 120.00 | 0.19 |
| light/reduced | timeline | after | 6.83/7.58 | 1.21/1.30 | 26/21 | 5/373 | 47.35 | 2279.5 | 229.0 | 120.00 | 0.21 |

## Desktop WebKit resources and input

The process group includes this Playwright browser and its WebKit XPC services, identified by the cached WebKit framework path; it excludes Vite, the automation driver and other apps. Browser rAF callbacks precede paint. Native probes end CPU scene construction, so these stages are not interchangeable. WebKit does not expose native-equivalent per-frame layout/render costs through this fixture.

| Mode | Scene | CPU % | GPU ms/15 s | MiB | Processes | Outstanding max | ACK p50/p95 ms | Drain ms | DOM wheel→rAF p50/p95 ms |
|---|---|---:|---:|---:|---:|---:|---|---:|---|
| dark/normal | list | 32.96 | 364.8 | 526.0 | 4 | 4 | 13.51/22.34 | 0.14 | 14.00/15.00 |
| dark/normal | summary | 44.82 | 160.3 | 566.0 | 4 | 4 | 16.00/23.67 | 0.18 | 13.00/14.00 |
| dark/normal | changes | 46.53 | 218.5 | 575.0 | 4 | 8 | 17.05/22.77 | 10.21 | 13.00/14.00 |
| dark/normal | timeline | 60.32 | 131.9 | 599.0 | 4 | 5 | 18.97/26.57 | 6.28 | 11.00/12.00 |
| dark/reduced | list | 39.96 | 480.9 | 477.0 | 4 | 4 | 14.60/22.32 | 2.60 | 14.00/16.00 |
| dark/reduced | summary | 45.14 | 422.7 | 518.0 | 4 | 4 | 15.00/21.67 | 6.87 | 13.00/15.00 |
| dark/reduced | changes | 43.73 | 427.2 | 529.0 | 4 | 8 | 16.65/22.75 | 9.78 | 13.00/15.00 |
| dark/reduced | timeline | 57.79 | 508.2 | 558.0 | 4 | 5 | 17.98/26.11 | 6.06 | 11.00/12.00 |
| light/normal | list | 37.65 | 444.0 | 525.0 | 4 | 3 | 15.26/20.96 | 0.16 | 14.00/15.00 |
| light/normal | summary | 36.41 | 270.9 | 610.0 | 4 | 10 | 13.94/23.14 | 0.32 | 13.00/14.00 |
| light/normal | changes | 39.80 | 240.3 | 643.0 | 4 | 6 | 15.43/19.94 | 6.73 | 13.00/14.00 |
| light/normal | timeline | 57.05 | 246.5 | 693.0 | 4 | 6 | 16.54/23.48 | 8.71 | 11.00/12.00 |
| light/reduced | list | 25.02 | 320.6 | 535.0 | 4 | 6 | 11.89/21.05 | 0.14 | 15.00/16.00 |
| light/reduced | summary | 39.14 | 334.2 | 595.0 | 4 | 5 | 17.12/30.39 | 23.35 | 13.00/28.00 |
| light/reduced | changes | 39.87 | 191.5 | 561.0 | 4 | 10 | 24.51/39.43 | 4.86 | 28.00/30.00 |
| light/reduced | timeline | 54.80 | 227.9 | 630.0 | 4 | 7 | 15.82/25.33 | 0.23 | 12.00/13.00 |

## Read-only real PR

PR #109, file index 15 for Changes (native/README.md), same input/full-rate settings. Short/clamped real scenes may submit no frames; a dash is not a zero-cost scrolling claim.

| Mode | Scene | Variant | Frame p50/p95 ms | Render p50/p95 ms | Layout p50/p95 ms | Outstanding max | ACK p95 / drain ms | CPU % / GPU ms / MiB |
|---|---|---|---|---|---|---:|---|---|
| dark/normal | summary | real-after | 16.66/16.92 | 5.44/5.87 | 0.96/1.05 | 1 | 3.83/0.23 | 38.88/1690.6/217.0 |
| dark/normal | changes | real-after | 16.65/17.22 | 5.41/5.81 | 1.28/1.60 | 1 | 2.59/0.13 | 38.90/2722.4/231.0 |
| dark/normal | timeline | real-after | 16.59/18.88 | 4.59/5.61 | 1.03/1.26 | 1 | 2.50/0.24 | 35.38/1821.3/231.0 |

## App-wide experiments

These controls use dark/normal/full rate. `frame-draw` disables synchronous test-support drawing and relies on platform frames; wheel controls disable the explicit accumulator to isolate scheduling. Pointer controls use 120 Hz sinusoidal native pointer RPCs with no wheel input. The ungated controls use the same native Markdown/list fixture with every PR opt-in removed, comparing ordinary drawing with frame-draw. The native synchronous-bounds check fails with frame-draw enabled (Element has no painted bounds); this is recorded in app-wide-check.log. Pointer controls generated at most one submission because their path stayed over plain content, so they do not establish hover/drag redraw safety. One warm-up packet can overlap the timed frame-draw batch (1,801 painted packets); offered-to-paint matching is therefore withheld for those controls. The user deferred the deep resource pass; these are quick scheduling checks, without a default decision based on CPU/GPU gains. These flags remain opt-in: the full interaction/drag surface has not been proven safe for an app-wide default.

| Variant / repeat | Scene | Frame p50/p95 ms | Render p95 ms | Outstanding max | ACK p95 / drain ms | CPU % / GPU ms / MiB |
|---|---|---|---:|---:|---|---|
| experimental-frame-draw/0 | summary | 16.66/16.79 | 5.98 | 2 | 5.93/0.20 | 40.15/1531.0/227.0 |
| experimental-frame-draw/0 | changes | 16.67/17.40 | 5.85 | 1 | 3.39/0.16 | 38.22/2752.3/243.0 |
| experimental-frame-draw/0 | timeline | 16.68/17.56 | 5.71 | 1 | 2.51/0.18 | 38.53/1811.5/241.0 |
| pointer-before/0 | summary | —/— | — | 1 | 0.68/0.77 | 8.17/0.0/215.0 |
| pointer-frame-draw/0 | summary | —/— | 2.30 | 1 | 0.64/0.42 | 7.50/0.0/216.0 |
| ungated-pr/0 | summary | 16.67/17.57 | 4.66 | 1 | 4.94/0.18 | 58.51/220.8/143.0 |
| ungated-frame-draw/0 | summary | 16.66/16.99 | 5.82 | 1 | 0.97/0.21 | 38.02/755.8/153.0 |

Idle after scrolling, with physical mouse input excluded from our floating fixture: 0 submissions over 15 s; GPUIX
  21380  bun                                   216.0 MiB  cpu   3.45%  gpu     0.0 ms
  total                                        216.0 MiB  cpu   3.45%  gpu     0.0 ms over 15.05s. Baseline: 0 submissions; GPUIX
  21522  bun                                   216.0 MiB  cpu   4.17%  gpu     0.0 ms
  total                                        216.0 MiB  cpu   4.17%  gpu     0.0 ms over 15.05s. The earlier uncontrolled physical-pointer sample is preserved as idle-physical-pointer-enabled.json; it is not an idle result.

## Root cause and implementation

The release addon enables GPUI test-support for automation. App::flush_effects consequently drew every dirty window after each App update, including physical NSEvent callbacks. A 120 Hz producer could require ~16 ms per packet and accumulate seconds of transport/OS work even when visible submissions remained near 60 Hz. Physical macOS wheel events enter Window::dispatch_event directly; native GPUI List handles offsets without a JS/native RPC. Automation adds its own per-packet transport before this shared boundary.

GPUI list re-created every visible row and called layout_as_root on each frame, while TaffyLayoutEngine.clear destroyed the previous geometry. Parse/syntax caches retained formatted content but did not avoid layout. Summary was one giant Markdown row.

- GPUI List now invokes its paint-bounds callback (it implemented InteractiveElement but skipped that callback). This makes the PR-only native viewport gate functional; the burst test requires both painted List bounds and actual merged packets. scroll_input.rs accumulates precise wheel packets in one slot for painted PR viewports, scheduling one display callback. Same-direction deltas sum; a reversal uses the latest direction. Contact/terminal markers retain axis-reset semantics; zero-distance markers do not reset List’s accumulated offset. Non-wheel events and changed target/modifiers flush pending input before dispatch, and removed targets discard stale batches. Offscreen/idle windows gain no repeating timer. KYBERN_SCROLL_COALESCE=all is an experimental app-wide wheel mode; =0 is a control. KYBERN_INPUT_FRAME_DRAW=1 experimentally bypasses the synchronous test-support draw and uses existing platform-frame scheduling for all input. Both app-wide modes remain opt-in pending wider validation.
- native/patches/scroll_taffy.rs retains root-relative geometry, styles, topology and final measurement inputs. Keys include retained list/row identity and content revision; available size, device scale, styles and measured results must match. Each measured leaf is primed once to initialize the fresh frame's TextLayout/inline state. Unchanged roots bypass the flex solver. The cache holds no frame arena IDs or AnyElements; it is bounded to 128 roots/16,384 nodes, with per-root 8,192-node limit and two-frame expiry outside the visible window.
- scroll_layout.rs is a transparent element wrapper. Prepaint and paint always run, rebuilding viewport masks, hitboxes, hover/link listeners, selection/search geometry and automation bounds at the new offset. This is layout-geometry reuse, not retained scene translation or complete paint-only scrolling.
- scroll_js.py adds optional automation touch phases and declarations without upgrading dependencies. The real renderer and phase fixture share native Window dispatch; unsupported headless phase injection fails explicitly.
- scroll_hooks.py / scroll_gpui.py reconstruct the native and GPUI edits. Shared apply_hooks.py and backdrop_gpui.py only gain their dispatch calls.
- GPUI cached views ordinarily set window.refreshing while rebuilding a dirty cached parent, which forces every nested cached child to rebuild. PR viewports use independent_scroll_cache with the retained root revision: clean siblings may reuse their layout/paint under that internal parent refresh. Explicit window refresh still invalidates selection/appearance. Any retained content/style change invalidates the revision, and active native motion builds these PR boundaries inline to preserve ancestor opacity/transform paint state. Existing non-PR cache semantics stay on the original path.
- PR_SCROLL_LAYOUT opts in the PR list, Summary, file list, Timeline and native diff rows. Diff content/theme/expansion changes increment its cache generation. No Markdown chunking, source substitution, selection splitting, sidebar drag changes or second paint-translation primitive is introduced.
- native/scroll8-check.ts compares full-layout/cached pixels in dark/light × normal/reduced after scrolling, width/source/ancestor-opacity changes and deterministic ancestor-motion frames, and verifies selection, search and link clicks. native/update.sh registers it. The preview UI lease helper accepts only a matching explicit parent lease; perf/scroll8-update.ts acquires the lease before the final short rebuild, then holds it through the native check batch.

## Evidence and remaining acceptance

Native exact-pixel controls (all four modes, full update.sh passed): /Users/mymac/projects/ade/previews/gpuix/round8/scroll/cache/. Full-app and desktop reference captures: /Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-*.png and /Users/mymac/projects/ade/previews/gpuix/round8/scroll/desktop-webkit-120hz-*.png. Raw timing/resource data, packet acknowledgements and frame logs remain in this directory.

Real-daemon PRs are accessed through scroll8-real-fixture.ts, which forwards only github.pr.list/detail/page and rejects other GitHub calls. Boot/session state remains in the disposable fixture. PR #109 has 810 changed files, a 2,240-byte description and no comments; the largest file on its first page is native/README.md (1,071 patch lines). A no-comment real Timeline cannot establish long-Timeline performance.

Scope update: the user deferred the deep RAM/CPU/GPU/fps optimization pass until the port is complete. This lane finishes the user-felt scroll backlog, four-mode parity, a quick app-wide scheduling check, and a read-only real-PR spot check. Further resource tuning and a deep four-mode real-PR matrix are deferred. The four-mode fixture, real-PR spot check, visual controls and idle check are complete. Validation and cleanup are listed below.

## Visual review and functional limits

The full-app controls compare layout/islands disabled and enabled with the same source, clock and fixture. All sixteen PNG files are byte-for-byte identical. Native lab controls additionally cover scroll offsets, content/width/ancestor-opacity changes and four deterministic motion frames, with selection/search/link assertions. This establishes preservation of the native appearance, not complete desktop-port parity. The desktop reference still differs in Summary text-column width and the linked-conversation block, and in some Timeline spacing; these are present in the uncached controls too.

| Mode | Desktop WebKit / GPUIX pairs | Native uncached / cached pairs |
|---|---|---|
| dark/normal | [list](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-dark-0-list.png) · [summary](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-dark-0-summary.png) · [changes](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-dark-0-changes.png) · [timeline](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-dark-0-timeline.png) | [list](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-dark-0-list.png) · [summary](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-dark-0-summary.png) · [changes](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-dark-0-changes.png) · [timeline](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-dark-0-timeline.png) |
| dark/reduced | [list](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-dark-1-list.png) · [summary](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-dark-1-summary.png) · [changes](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-dark-1-changes.png) · [timeline](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-dark-1-timeline.png) | [list](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-dark-1-list.png) · [summary](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-dark-1-summary.png) · [changes](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-dark-1-changes.png) · [timeline](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-dark-1-timeline.png) |
| light/normal | [list](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-light-0-list.png) · [summary](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-light-0-summary.png) · [changes](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-light-0-changes.png) · [timeline](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-light-0-timeline.png) | [list](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-light-0-list.png) · [summary](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-light-0-summary.png) · [changes](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-light-0-changes.png) · [timeline](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-light-0-timeline.png) |
| light/reduced | [list](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-light-1-list.png) · [summary](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-light-1-summary.png) · [changes](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-light-1-changes.png) · [timeline](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/pair-light-1-timeline.png) | [list](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-light-1-list.png) · [summary](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-light-1-summary.png) · [changes](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-light-1-changes.png) · [timeline](/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-cache-light-1-timeline.png) |

The optional PR action check fails in all four modes: the review popover places its submit button below the window (y≈2,718). This also reproduces with the original round-7 addon, layout=0 and islands=0; see actions-baseline-round7-dark-0.png/json and actions-baseline-round7-config.json. No GitHub writes occur: all attempted actions target the in-memory fixture. This existing action issue is unresolved and must not be described as a passed interaction check.

One light/reduced native timing attempt produced no Summary/Changes/Timeline paints and later flushed accumulated packets at an interaction barrier. It is preserved under invalid-no-paint-after-light-1.* and excluded; the replacement requires >200 submissions and exactly 1,800 matched packets in every scene. A covered background macOS window can stop display callbacks, but occlusion was not instrumented in that rejected run, so its cause remains unproven.

## Acceptance result

16/16 final fixture scenes collected. Patched submission p95: 16.88–18.80 ms; CPU render p95: 3.16–8.15 ms; layout p95: 0.77–1.87 ms. RPC drain: 0.10–0.34 ms; final CPU-paint drain: 0.00–12.16 ms. Maximum transient outstanding RPC depth: 6, compared with 1472 before. Outstanding RPC counts measure transport acknowledgements, not a native event queue. All requests are awaited to zero; the native pending accumulator is bounded to one slot.

The seconds-long input backlog is resolved in the synthetic PR fixture. A literal every-scene p95 ≤16.7 ms is not met; WebKit reference p95 is usually 17–19 ms, with light/reduced Changes at 34 ms. These results do not establish physical display presentation or replace the user's trackpad test. Keep R3-8 partial until that hands-on check.

## Validation and cleanup

- native/update.sh passed end to end; the final log ends with `done: GPUIX 0.10.0 with Kybern patches`. It includes the existing native regression suite and the new four-mode geometry/pixel/motion and input-burst checks.
- pnpm typecheck and pnpm exec tsc --noEmit -p native/tsconfig.json passed.
- bun test ./src: 107 passed, 0 failed, 4,650 expectations. git diff --check passed for the final source/report changes.
- Branch: gpuix/scroll8. Core commits: 77206f69 and b89f2dee; measurement infrastructure: c199fd31. The source package remains pinned to GPUIX 0.10.0. Integration must regenerate the combined JS package patch and pnpm patch hash after applying the other native lanes.
- Final addon SHA-256: `0d8cedbc5892b4def62c2b07e115dc833bb8303c995dfb1f6660de3b34d58052`. The retained addon contains this lane on the round-7 combined base, rather than the other round-8 lanes.
- Free space: 113 GiB before heavy work, 114 GiB before cleanup, 114 GiB after. Stopped own port-4282 daemon; removed its scratch data, native target/upstream/staging/old addons, and disposable GPUIX/desktop node_modules. No whole worktree, real daemon/data or other lane output was removed. Actual df remained 114 GiB; no reclaimed-block claim.
- Retained: Final addon + webview dylib (~24 MiB) and evidence (~165 MiB).

Shared edits are additive in native/patches/apply_hooks.py, backdrop_gpui.py, patch_js.py, native/update.sh, scripts/preview-ui-lock.ts, the pinned native JS package patch and pnpm-lock.yaml. New native files are scroll_input.rs, scroll_layout.rs, scroll_taffy.rs, scroll_gpui.py, scroll_hooks.py and scroll_js.py. PR source opt-ins live in src/pulls/scroll-layout.ts, PullRequestsPage.tsx, PrDetail.tsx and PrTabs.tsx. The fixture gains read-only browser session/CORS and empty queue support; the action verifier gains failure evidence. No other lane's native patch file was edited.
