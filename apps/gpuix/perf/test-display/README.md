# Hidden test display

Automated GPUIX windows (`GPUIX_BACKGROUND=1`) open on a hidden virtual display
instead of the screen the user is working on. The display is a 1440×900 @2x,
60 Hz virtual display (private `CGVirtualDisplay`, as DeskPad and BetterDisplay
use) parked diagonally off the main screen's bottom-left corner. Windows on it
are fully composited, so timings and screenshots stay valid.

```sh
clang -fobjc-arc -framework Foundation -framework CoreGraphics perf/test-display/main.m -o /tmp/kybern-test-display
/tmp/kybern-test-display &      # writes its display id to /tmp/kybern-gpuix-test-display
kill %1                         # removes the display and the marker
```

Placement: `automation_display.rs` in the gpuix fork (`native/upstream/packages/native/src/`, native windows) and
`src/shell/window.ts` (the app opens hidden, then moves by origin, because
`setFrameFromString:` snaps a window back onto the main screen) target the id
in `/tmp/kybern-gpuix-test-display`, else the built-in display.
`KYBERN_TEST_DISPLAY=any` restores GPUI's default placement.
