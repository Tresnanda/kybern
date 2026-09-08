# Mobile long history and Android rendering — 2026-09-09

Long conversations had three independent costs: complete transcript downloads,
repeated animated scrolling as variable-height rows were measured, and nine
Android backdrop captures across the top and bottom fades. Streaming also
invalidated composer subscriptions that only needed commands or usage.

The client now mounts a LegendList at the end after hydration, loads 60 recent
entries when the daemon supports paging, and fetches older pages while browsing.
Stable keys and row objects preserve settled content; expansion state survives
virtual unmounts. Page requests freeze their event sequence and replay in-flight
events, including child-agent activity. Older unfinished rows accompany the first
page so live deltas retain their beginning. Equal-sequence boundaries may also
extend a page beyond its requested entry count.

Android uses one gradient-masked backdrop pass per edge, with opacity and blur
radius adjusted to approximate the previous material. iOS retains layered blur.
The Android menu uses a hardware-accelerated, edge-to-edge modal and native
rounded clipping instead of an animated software mask. Its original independent
position, size and roundness springs remain; labels are not scaled.

## Native workload and results

Apple M1 host, Android Emulator 36.5.11, Android 15/API 35 Google APIs arm64,
Pixel 7 AVD at 1080 × 2400 / density 420, host GPU. Both comparisons used installed
release APKs and Hermes, with no screen recording during the scrolling samples.
The baseline was mobile 0.1.0 build 2. The final run was 0.1.1 build 3 with preview
update group `fdcd2a9f-9a58-498d-ab25-2b46e359a153` applied.

`fixture-server.mjs` supplies 400 completed turns / 2,000 entries, with prose,
code fences, tables, and two large collapsed tool results per turn. It deliberately
returns full history to exercise compatibility with older daemons. Each sample
starts at the newest reply and performs eight `adb shell input swipe 540 650 540
1550 500` gestures, with 250 ms pauses. Active samples add a synthetic text delta
every 50 ms while the reader scrolls away from the live response.

| Android `dumpsys gfxinfo` frame duration | Before | Final |
| --- | ---: | ---: |
| Idle p50 | 77 ms | 22 ms |
| Idle p95 | 113 ms | 26 ms |
| Idle rendered frames | 136 | 380 |
| Streaming p50 | 89 ms | 23 ms |
| Streaming p95 | 200 ms | 27 ms |
| Streaming rendered frames | 112 | 388 |

An intermediate build with the new list but all nine blur passes still measured
77 ms idle p95, supporting the separate backdrop-cost diagnosis. These are single
emulator samples under a shared host workload, not physical Samsung S25 results
or a 60 fps guarantee. Frame duration is not frame interval, React commit time,
input latency, CPU consumption, or energy. Those metrics were not measured here;
do not derive battery or typing-latency claims from these numbers.

The old opening recording was still showing reply 234 at 14 seconds. The new
client opened directly at reply 400 without scrolling through earlier replies.
Formatted code and table cells, copy controls, and the final marker were present.
Reading away from a streaming response stayed away and exposed Latest. Against
the real scratch daemon, browsing crossed the initial 60-entry boundary to reply
377; Latest returned to reply 400. Menu recordings show the trigger-position
start, intermediate morph, and outside-tap dismissal. Thread details navigation
worked. Light and dark appearance were inspected. Physical iOS, accessibility
contrast/transparency modes, sustained thermal load and energy remain unmeasured
in this pass. Desktop WebKit fixtures do not exercise this React Native path.

## Transport and history integrity

The real scratch daemon projected the equivalent 2,000-entry fixture. Run:

```sh
KYBERN_DATA_DIR=/tmp/kybern-mobile-performance-daemon \
  node apps/mobile/perf/check-hydration.mjs --all-pages
```

The final run returned 60 entries in **422,053 bytes**, versus **14,048,099 bytes**
for full history (about 97% less initial payload). The local RPC wall times were
128 ms and 697 ms respectively; these are not isolated CPU measurements. All
34 pages matched the full sequence-bounded projection exactly. Tests additionally
cover equal-sequence boundaries, unfinished older rows, in-flight text and tool
completion, row identity, and compatibility with old daemons.

The daemon still reads and projects historical events before selecting a page.
This bounds transport and client hydration, not the daemon's projection cost.
Existing clients retain full-history semantics. Older daemons ignore the optional
parameters, and the new mobile list still works with their complete snapshots.
The paging benefit requires a daemon built with this change; an OTA cannot update
the computer's daemon.

## Reference and delivery

Reviewed [T3 Code's native thread feed at 7fbc545](https://github.com/pingdotgg/t3code/blob/7fbc545ae8c7866ac2b39648120cb2a17250d8b4/apps/mobile/src/features/threads/ThreadFeed.tsx):
LegendList, initial end positioning, bounded draw distance and explicit live-follow
behavior informed this approach. Its React Native renderer was the relevant
reference, rather than copying a desktop virtualizer.

Mobile 0.1.1 enables EAS Update on preview/production channels with fingerprint
runtime compatibility. Build 3 and the tested Android update share runtime
`fa4dbf0c6c9cdf270fa3127fba35552d8fb78859`. Manual check, download and restart were
verified in the installed APK. Compatible updates also download on launch and
apply at the next launch without interrupting an open conversation.

Validation: 28 mobile tests, TypeScript, Expo Doctor (21 checks), Android and iOS
production exports; protocol/store/daemon/CLI tests, Rust formatting and targeted
Clippy; desktop TypeScript/lint/build for the shared wire changes. Generated
recordings, APKs and raw metrics stay outside commits.

## Turn disclosure follow-up

Completed turns now reuse the desktop final-answer grouping. Earlier narration,
reasoning and tools collapse under "Worked for…"; completed background processes
join that disclosure. Delegated agents, active work, pending approvals and errors
remain visible. Expanded work stays as individual LegendList rows, with cached
settled identities and expansion state retained while those rows unmount.

The 1,000-tool test produces four collapsed rows (user, disclosure, answer,
completion) and exposes all 1,000 tools as separate rows when expanded. Tests
cover partial pages without their final message, running turns without a loaded
user message, images, and updates in another turn. All 34 mobile and 106 desktop
tests passed, along with typechecks, desktop lint/build and native exports.

An iPhone 17 Pro / iOS 27 simulator on the M1 host ran the production-mode bundle
in Expo Go 57.0.9 against the same 400-turn fixture. The disclosure's measured
screen Y stayed at 423.33 points through expansion and collapse; tool rows appeared
only when open and the final answer retained its separate formatting. The compact
menu measured 272 × 309 points for this fixture, with 44-point item targets.
These are layout and interaction checks, not release-APK or physical-device
timings. The Android frame-duration measurements above predate this follow-up.
