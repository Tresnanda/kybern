# Recent thread cache and Android sheets

The existing three-thread memory cache discarded a closed thread on its next
event and on reconnect. It now retains the last snapshot and marks it stale.
Reopening an unchanged thread skips `threads.get`; a stale thread keeps its
content mounted while one deduplicated request catches up. The subscription is
acknowledged before hydration, and events received during the request are replayed.

A disconnect during a pending request invalidates that request's freshness even
if it later resolves. Reconnecting to the same computer retains snapshots;
switching computers clears them. Failed refreshes leave both readable content and
the retry requirement intact. Eviction follows thread visits rather than stream
updates, protects observed/pending work, and runs again when requests finish.
This is an in-memory session cache, not persistence across process restarts.

The Android route sheets now translate upward from below the display. The existing
mass spring leads the outline spring; a small width/height and corner adjustment
settles behind it. An absolutely positioned clipping surface contains fixed-size
content, so labels translate without scaling or rewrapping on every frame. The
same path reverses on dismissal. Reduced motion retains a short fade. Existing
opaque Android surfaces, drag dismissal, keyboard handling, and iOS native sheets
are preserved.

## Verification

- TypeScript, 45 mobile tests, Expo Doctor (21 checks), and iOS/Android exports pass.
- Cache tests cover reuse, stale content, buffered events, failed refreshes,
  disconnects during initial/existing loads, eviction, and clearing the cache.
- iPhone 17 Pro / iOS 27 simulator, Expo Go 57.0.9, Apple M1 host: a synthetic
  12-turn / 60-entry server delayed snapshot replies by 1,800 ms. First open made
  one snapshot request; unchanged reopen made zero additional requests. Output
  received while closed caused one catch-up request on reopen. Formatted code,
  table cells, and final streamed text were verified through the native UI.
- A screenshot captured 1,116 ms after initiating stale-thread navigation had no
  loading indicator, but the native push transition and initial list layout were
  still in flight. This is not a measurement of time to first readable content.
- Pixel 7 / Android 15 API 35 emulator (1080 × 2400, host GPU, two cores,
  2 GB guest RAM), Expo Go 57.0.9: recorded the previous and new project-picker
  entrances. The new panel moves from below the display with readable, unscaled
  content during its rise; the earlier version grew from a central silhouette
  before its content appeared. Keyboard entry retained the search field and
  project row above the keyboard. Back and header-drag dismissal passed. A fresh
  launch with Android's animation scales disabled verified the stationary fade
  and successful dismissal in dark mode. Recordings and extracted review frames
  remain in the uncommitted artifact folder.

No CPU, frame-rate, energy, physical-device or release-APK motion claim follows
from these simulator checks.
