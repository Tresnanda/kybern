# Live session resource sample — 2026-09-06

Measured the already-running packaged Kybern during an active coding turn, at
13:32:35–13:32:45 UTC+8. The candidate branch was not installed. This is a brief
live sample, not an idle benchmark or a before/after comparison.

Command: `top -l 6 -s 2 -pid <app> -pid <gpu> -pid <webcontent> -pid <networking> -pid <daemon> -stats pid,command,cpu,mem,power`.
Discard the first CPU sample (no preceding interval). Five two-second intervals:

| Process | Mean CPU | CPU range | top MEM range |
| --- | ---: | ---: | ---: |
| WebKit renderer | 37.66% | 24.9–61.1% | 749–1129 MB |
| WebKit GPU | 4.58% | 2.6–6.9% | 51–92 MB |
| Desktop shell | 3.96% | 3.1–4.6% | 56 MB |
| Daemon | 0.02% | 0–0.1% | 42 MB |
| WebKit networking | 0.02% | 0–0.1% | about 8.7 MB |

Combined mean CPU: 46.24%, where 100% represents one CPU core. Summed reported
memory was about 0.9–1.3 GB. These numbers exclude spawned coding-agent processes,
WindowServer, and this task's build/browser tools; they are not the entire
machine's consumption. Memory columns should not be treated as unique physical
RAM because process accounting can include shared resources.

The renderer dominates this sample. It does not establish a memory leak or
identify which component used the CPU. The earlier matrix benchmark measures
only that component and must not be presented as a whole-app reduction.

No watts or joules were measured. `top` POWER is an estimated score, not watts.
The daemon's current database schema records turns, tokens and provider quotas,
but does not persist RAM, CPU, or energy samples. This report preserves the
manual measurement; it does not add a background telemetry service.

## Translucency diagnosis

The actual App shell in an isolated browser preview reproduced the layering bug:
with the setting on, the content card computed to 72% alpha but its SidebarInset
wrapper still computed to opaque `rgb(16, 16, 16)` in dark mode. With the wrapper
transparent, the preview background is visible through the card. Light mode
also retains the intended 72% alpha; switching off restores an opaque card.
Split panes now share the parent fill instead of applying a second tint.

The preview substitutes a static background for macOS material. It verifies CSS
composition, not a newly installed native app. The running app and daemon were
not restarted. Native window configuration was not changed.
