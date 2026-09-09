# Composer camera and sheet follow-up — 2026-09-09

Android sheets and detent changes now use a 400 ms spring configuration instead
of 300 ms, retaining velocity handoff and the following outline. The composer's
measured attachment menu returns to its plus icon throughout exit; its labels
fade with the collapsing surface. The narrower attachment menu uses regular-weight rows ordered Camera, Photos,
Files, Plugins, and Project files.

The shared Android/iOS camera opens from the measured composer into a rounded
bottom panel occupying at most 62% of the safe viewport, with the conversation
visible above. Back, shutter, and lens controls sit inside the preview. It supports
camera permission recovery, front/back cameras, capture, retake, and review. Use photo
uploads before flying the captured image into the measured composer thumbnail.
The flight smoothly uncrops the preview into the contained thumbnail image.
The existing acknowledged-message send transition carries that attachment into
the transcript. Reduced motion uses stationary fades. Upload failures retain the
captured photo for retry; uploads have a 25 MB limit and 30 second timeout.

## Verification

The bottom-panel follow-up was rebuilt and checked in the same release emulator:
conversation visibility, compact light menu, capture, and thumbnail landing.
Typecheck and the iOS export passed again. Recordings are
`composer-camera-panel.mp4` and `composer-panel-landing.mp4`; still previews are
`composer-reference-menu.png` and `composer-camera-panel.png` in the artifact folder.

- Android 15 / API 35 arm64 Pixel 7 emulator, release Hermes APK, on an Apple M1
  Mac with 16 GB RAM; a local fixture server accepted assets and normalized sent
  attachments to inline images.
- Exercised camera permission grant, capture, retake, Use photo, thumbnail landing,
  and image send. Inspected recorded landing frames for continuous geometry and
  final image visibility. The emulator camera supplies a synthetic image.
- Opened and canceled the system Photos picker, then selected and attached a
  local fixture image through it.
- Recorded menu exit and inspected frames: the source remains a plus, with no
  ellipsis flash. Checked short sheet pulls returning and fast pulls dismissing.
- Checked dark mode with 1.5× text and reduced motion. Android symbol font scaling
  initially clipped glyphs inside fixed icon boxes; the shared Icon now compensates
  for font scale while labels continue to follow the system text size.
- Mobile typecheck, 49 existing tests, Expo Doctor (21/21), Android/iOS JavaScript
  exports, and an Android native release build passed. Generated permission config
  retains Android CAMERA, omits RECORD_AUDIO, and has iOS camera/photo descriptions.

Ignored local artifacts under `artifacts/mobile-motion/` include
`composer-photo-flight.mp4`, `composer-flight-landing.jpg`,
`composer-menu-exit.mp4`, `composer-menu-exit-review.jpg`, and
`composer-sheet-new.mp4`. The local APK uses NDK 27.1 and disables OTA in generated
native files so the embedded patch is tested. These local overrides are not source
configuration or a published build. The image-picker dependency and permission
configuration require a fresh native app build.

These are functional and visual checks. Physical-device feel, native iOS execution,
permission denial recovery, and upload timeout recovery were not exercised on a
device. No FPS, CPU, commit-time, input-latency, or energy improvement is claimed.
Earlier send-transition evidence is in `motion-2026-09-09.md`.
