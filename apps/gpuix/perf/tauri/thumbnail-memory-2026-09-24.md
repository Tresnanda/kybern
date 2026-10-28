# Attachment thumbnail memory — 2026-09-24

On Apple M1 / macOS 27.0, run `node scripts/check-rendering.mjs image-memory`
from `apps/desktop`. The native WKWebView uses the production CSP. The fixture
creates twelve distinct 2048×2048 PNG blob URLs, renders them as 64px
`ResponseImage` attachment chips, waits for all images to decode, then samples
WebContent with `vmmap -summary`. It also opens one chip and verifies that the
dialog still uses the original 2048px source. Each run has a fresh WebContent
process. The source images are identical between branches.

| Source | Ready current | Chips settled current | Lifetime peak through chips | Unmounted current | Decoded chip width |
| --- | ---: | ---: | ---: | ---: | ---: |
| Merged `main` (`508fcb7d`) | 66.4 MiB | 245.2 MiB | 498.9 MiB | 242.3 MiB | 2048px |
| Fitted thumbnail, run 1 | 70.4 MiB | 56.3 MiB | 253.3 MiB | 53.6 MiB | 128px |
| Fitted thumbnail, run 2 | 66.5 MiB | 59.2 MiB | 251.4 MiB | 51.5 MiB | 128px |
| Fitted thumbnail, original-dialog check | 70.0 MiB | 57.8 MiB | 254.3 MiB | 56.7 MiB | 128px |

The last run's unmounted mark follows an original-image dialog, so it is not a
strict chip-only comparison. The chip-settled mark precedes that dialog.
`chat-fixes` also passed, including restored drafts and thumbnail original
identity. A two-at-a-time fit queue was tested and discarded: its first run
peaked at 264.5 MiB and settled at 89.3 MiB, worse than the unrestricted fit
runs. The shipped change is just fitting chips to 128px.

This is an image-heavy single-window workload. It does not establish a lower
floor for text-only chats or show that the installed app now meets the
200–300 MB whole-app target. The reported values cover WebContent only, not
the Tauri shell, daemon, GPU, networking, provider processes, or WindowServer.
