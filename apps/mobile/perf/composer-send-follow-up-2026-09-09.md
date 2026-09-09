# Composer motion corrections — 2026-09-09

Follow-up to the device report of a lingering attachment-menu ring, sheet bottom
flicker, camera preview escaping rounded corners, and send motion waiting for the
server and fighting keyboard dismissal.

## Changes

- The attachment menu keeps its entrance springs. Exit geometry completes in
  220 ms using an ease-in-out curve. Material and shadow stay visible through
  the return, fading together only within the last 12% of its size interpolation.
  The earlier 140 ms surface fade hid the return and looked like a pop; it has
  been removed for normal motion. Reduced motion retains a 140 ms fade.
- Android sheet detents share a fixed full-height measured parent. Only the
  silhouette's height and top offset animate, with a 500 ms / 0.8 damping-ratio
  spring. Its bottom stays anchored. Children retain their destination layout;
  short pulls, velocity handoff, and the following outline remain intact.
- Android camera uses CameraX's compatible TextureView preview, which participates
  in ancestor clipping. The pinned expo-camera patch must be built from source:
  package.json opts only expo-camera out of Expo's prebuilt Android binaries.
  iOS requests continuous corner curves. This native patch needs a new APK.
- Normal sends create a local outgoing row and measured flight before the RPC.
  Keyboard dismissal and composer clearing happen together after measurement.
  The flight samples its destination on the UI thread and waits for both its
  spring and the keyboard geometry to settle. Composer ancestors no longer run
  a second layout animation during the keyboard/photo handoff; recoil and
  thumbnail motion remain.
- Canonical events and receipts reconcile to one row with stable identity;
  receipt-before-event, event-before-receipt, and identical concurrent messages
  are covered. Failure removes the pending row and restores the draft. New task
  navigation waits for the flight to land. Images retain their part identity
  and omit Android's independent image-loading fade.

## Verification

Android 15 / API 35 arm64 Pixel 7 emulator, release Hermes APK, Apple M1 Mac with
16 GB RAM. A scratch localhost fixture accepted image assets, normalized them to
inline images, and imposed a two-second delay before sending events and receipts.
No real agent or user data was used.

- Recorded before/after menu exits and sheet collapses. A first sheet revision
  still jumped for one frame; the final fixed-parent revision removed that jump
  in the recording and retained its bottom edge throughout collapse.
- Verified live colored camera-preview corners. The initial patched build still
  linked Expo's prebuilt camera; the final Gradle log confirms source compilation,
  and the resulting live preview respects the rounded panel.
- Recorded a keyboard-visible text send with a 2006 ms request-to-receipt delay.
  At approximately 700 ms after tapping Send, the keyboard was closed and the
  complete outgoing text was already visible with Sending status.
- Exercised camera capture, Use photo, composer thumbnail landing, and creating
  a new task with an image and text through the delayed fixture. Confirmed one
  image and the exact text in the resulting task.
- Repeated the image handoff after disabling the independent image fade; the
  photo remained visible in the pending bubble before the receipt arrived.
- Checked readable dark menu/sheet surfaces with Android reduced motion enabled.
- A deliberately rejected send restored the exact draft text, showed the error,
  and removed the outgoing presentation.
- Mobile typecheck, 54 tests, Expo Doctor (21/21), Android/iOS exports, frozen-lockfile
  install, and the Android release build passed.

Ignored recordings and screenshots live in artifacts/mobile-motion, including
menu-tail-before.mp4, menu-after.mp4, sheet-before.mp4, sheet-final.mp4,
send-delay-after.mp4, send-pending-700ms.png, camera-final.png, and
new-thread-after.mp4, image-final.mp4, image-pending-final.png,
menu-dark-reduced.png, and sheet-dark-reduced.png. Local generated native files temporarily used NDK 27.1 and
OTA disabled to test the embedded bundle; these are verification overrides only.

These checks establish behavior and visible geometry in the emulator. They do
not establish physical-device feel, native iOS behavior, frame-rate improvements,
CPU savings, commit time, or energy use. The emulator's synthetic camera capture
can be black even when its live preview shows a colored test scene.

## Compact composer and separate photos

The subsequent layout pass reduces the composer to a 44 dp minimum input and
44 dp toolbar with 6 dp padding. Running conversations use a Queue/Steer menu
beside Send/Stop instead of a separate mode row. Model, permissions, and usage
share the model button's sheet; its tabs scroll at larger text sizes. Full-access
and near-full-context indicators remain available in the compact controls.

Images now occupy individual square tiles above the text bubble. Multiple images
scroll horizontally; tapping a tile opens the uncropped image. Local pending
images retain their URI and part identity through reconciliation. Send motion
paints the text surface separately and lands images in their individual tiles.

The Android sheet spring is now 500 ms, with a 550 ms following outline. Drag
deformation changes its width and corner radii according to the touched edge,
while the content stays unscaled. Reduced motion omits the deformation.

Release-emulator checks covered three-image scrolling through the last image,
opening and closing the full image, the compact running composer, and accessible
Queue/Steer/Stop actions. The first send-menu revision opened downward; the final
revision opens above the composer so all three actions fit. Checked 360 dp width
with 130% font scaling, as well as dark surfaces and reduced motion. The larger
font exposed truncated options tabs; these now size to their labels and scroll.
Recorded sheet pull/recoil and expansion/collapse. These are visual behavior
checks, not performance measurements or a physical-device motion assessment.

Evidence: compact-photos.png, compact-narrow.png, compact-menu-final.png,
compact-sheet.mp4, and compact-sheet-frames.png in artifacts/mobile-motion.
Typecheck, all 54 tests, Expo Doctor (21/21), both platform exports, and the native
Android release build passed. No update was published in this layout pass.

## Reference composer layout

The final reference-image pass restores separate permission and usage buttons in
the lower row: attachment, shield, context ring, model with reasoning effort,
and send. It removes the provider mark and model chevron. While working, an
icon opens the existing Queue/Steer/Stop menu. No dictation button is shown since
the app does not currently implement dictation. The input remains above the row.

Verified the release layout with fixture model gpt-5.5, medium reasoning, and
25% context use. Also checked the running composer at 360 dp and 130% text size;
the model label truncates while its full accessible label and controls remain
available. Screenshots: reference-composer.png and reference-composer-narrow.png.
Typecheck, 54 tests, both platform exports, and Android release build passed.

The subsequent menu-return correction was recorded in the release emulator:
menu-return.mp4 and menu-return-frames.png show the silhouette visibly shrinking
back to the plus button and disappearing without a residual ring. The exit is
initially bounded to 400 ms, and actions still wait for its completion before
opening the next surface. Typecheck, tests, both platform exports, and release
build passed for that recording. Subsequent feedback found 400 ms too slow;
the duration is now 220 ms, preserving the same collapse and late fade. This
timing-only adjustment passed typecheck; the recording predates that adjustment.

## Right-first flight and complete camera dismissal

The send now uses a quadratic path with horizontal departure and vertical arrival:
x advances by `1 - (1 - p)^2`, y by `p^2`. A 300 ms timing animation eases p with
`(0.32, 0.72, 0, 1)`. Live keyboard/list displacement uses those same axis weights.
Text, images, and the forming text surface share the curve. Destination movement
can change the absolute vertical direction while the keyboard closes; the flight
still lands at the actual message. It retains the stable-destination handoff.

Back cancels entrance geometry and translates the complete camera panel until its
top is 16 dp below the viewport. It does not shrink back to the composer or fade
its preview halfway through. Dismissal completes in 260 ms; reduced motion uses a
140 ms fade. The captured-photo attachment path is unchanged.

Verified the current JavaScript in Expo Go 57.0.9 on the API 35 arm64 emulator
against the delayed local fixture: exact text arrived once, the keyboard closed,
the curved overlay landed, and camera Back moved below the viewport before
unmounting. Recordings: `artifacts/mobile-motion/four-fixes-send.mp4` and
`four-fixes-camera.mp4`. This is development-runtime visual evidence, not a
release performance measurement. Expo Go lacks the patched native camera and
still displays square corners; the previous source-built release verification
above covers clipping. A new APK remains required for that fix on the phone.
No physical-device or iOS motion check was performed in this pass.

Mobile typecheck, all 54 tests, Expo Doctor 21/21, and both platform exports passed.
The accompanying daemon change removes per-turn artifact-guidance injection;
96 daemon tests pass (one ignored), including exact provider-message checks across
repeated text and image turns. Daemon clippy and workspace formatting pass.

## Keyboard-relative departure correction

The previous curve still anchored its source to the screen while only tracking
the destination. With the keyboard open, dismissal moved the composer away from
that source and could make the flight head downward. Capture the keyboard height
at send and track both endpoints: the source follows the composer's keyboard
displacement, weighted by the remaining vertical travel. Text, photos, other
attachments, and the forming text surface share the right-first quadratic path.
The timing is now 360 ms with `(0.77, 0, 0.175, 1)` easing. Photo growth follows
its center, avoiding a competing trajectory caused by changing dimensions.

Destination bounds are requested together instead of in serial bridge round
trips. The cleared input suppresses its placeholder during departure. Keyboard
dismissal and message submission remain immediate; stable destination handoff
and the timeout fallback remain intact.

Verified production Hermes JavaScript in an existing Android release binary on
the API 35 arm64 emulator, with a delayed local fixture. For this local check,
only the bundled JavaScript was replaced and the APK was aligned and signed
again; this is not a new native build or a distributable APK. Compared the prior
published bundle with the correction, then checked a photo with longer text and
reduced motion. Messages arrived once, wrapping matched, and the composer reset.
The global path still follows the keyboard downward while it closes; the flight
departs right and curves upward relative to the moving composer.

Evidence in `artifacts/mobile-keyboard-flight`: `before.mp4`, `after.mp4`,
`mixed-final.mp4`, their frame sheets, and `reduced-final.png`. These are visual
behavior checks, not frame-rate measurements or physical-device/iOS verification.
Typecheck, all 58 tests (including four endpoint/path regressions), Expo Doctor
21/21, and both platform exports passed. This correction has not been published.

## Restore the thread menu's original close

The attachment-menu correction unintentionally replaced the shared thread menu's
two spring tracks with a single 220 ms timing curve. Restore the pre-attachment
behavior as the default: MASS for the leading center, SIZE for the following
silhouette, original corner timing, size-driven label visibility, and material
and source icon retained through spring completion. The attachment menu alone
opts into `closingMotion="attachment"`, preserving its bounded close and late
surface fade before opening a picker. Reduced motion retains the 140 ms fade.

Compared the default branch with the implementation before commit `826fd50`;
the existing placement, clipping, and platform materials remain intact. Mobile
typecheck, 58 tests, and Android/iOS production exports pass. This is a source
restoration with build checks, not a new on-device motion verification or OTA.

Published the complete mobile correction on the Android `preview` channel with
the `preview` environment on September 9, 2026. Update group
`3adc6b45-d22c-4071-b63d-fbe3dda61712` uses runtime
`57f6c1de1af2ea527e8e19fbe0020a703fe67c3a`, matching APK build 6 with the native
camera clipping fix. The delivery endpoint returned the new update ID for that
runtime and channel. The daemon guidance removal ships separately in v0.3.2.
