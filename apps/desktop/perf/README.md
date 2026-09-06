# Matrix loader energy regression fixture

Run `pnpm dev --port 1439` from `apps/desktop`, then open
`http://localhost:1439/perf/matrix.html` in Safari. No daemon, credentials,
agent requests, or native Kybern instance are needed. This page is not an entry
point in the production build.

The fixture renders the real `MatrixLoader`: two 1.6-second sidebar orbits on a
blurred surface and one 1.2-second working indicator. It has no streaming,
polling, or JavaScript animation loop. `matrix-baseline.css` freezes the old
background-color implementation; Optimized loads the current `motion.css`.
Both buttons report the active animation count and animated property so a failed
stylesheet load cannot be mistaken for an improvement.

**Check appearance** freezes 36 dots at 65 phases across two cycles. It checks
geometry and compares their computed color/opacity composited over dark and
light backgrounds (tolerance: 2/255 per channel). It also checks actual browser
intersection clipping, frozen time while offscreen, phase-preserving resumption,
and the inactive mounted-pane rule. This color check does not compare complete
window screenshots or backdrop rasterization.

For CPU measurements, leave the page visible and alternate Baseline → Optimized
→ Baseline. Identify this Safari tab's WebContent and GPU PIDs plus Safari's PID
using `ps`/Activity Monitor, then measure each mode with:

```sh
top -l 5 -s 2 -pid <webcontent-pid> -pid <gpu-pid> -pid <safari-pid> -stats pid,command,cpu,time
```

Discard the first sample (no measurement interval). Keep other tabs quiet and
do not run builds during sampling. Percent CPU is in units of one core; CPU in
the GPU process is not GPU utilization or a direct power measurement.

## Recorded result

2026-09-06, macOS 27.0 (26A5416b), system Safari/WebKit. Four two-second samples
per mode, same window geometry, same three loaders, confirmed 36 running dot
animations in each mode:

| Mode | WebContent CPU | GPU-process CPU | Safari CPU | Combined |
| --- | ---: | ---: | ---: | ---: |
| Background-color baseline | 9.00% | 18.53% | 6.25% | 33.78% |
| Opacity + visibility handling | 3.70% | 0.20% | 2.58% | 6.48% |
| Baseline repeated | 9.03% | 18.63% | 6.33% | 33.98% |

About 81% less combined CPU in this isolated fixture. The production app was
left running because it hosted the development session. This is not a measured
81% reduction for the whole app: transcript rendering, shimmers, compilation,
native window materials, and agent processes are outside this comparison.

The browser regression checks passed with identical dot dimensions and a
maximum painted channel difference of 1/255 on both backgrounds. Offscreen
animation time froze, resumption preserved the phase, and inactive mounted
panes paused their loaders. The desktop's 70 unit tests, typecheck, lint, and
production frontend build passed. Native packaging was not run.
