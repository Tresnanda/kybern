# iPad attachment verification

Issues [#5](https://github.com/Tresnanda/kybern/issues/5) and
[#6](https://github.com/Tresnanda/kybern/issues/6) were checked on a physical
iPad Pro 11-inch (M4), running **iPadOS 26.6.1**. The app was built in Release
with Xcode 27 beta 4 / the iOS 27 SDK and installed with personal-team signing.
The SDK version is not the device's OS version.

The mobile dependencies remain Expo 57.0.21, React Native 0.86.3,
expo-camera 57.0.4, expo-image-picker 57.0.16, and expo-document-picker 57.0.1.

## Separate causes

**Picker presentation:** The attachment menu invoked its selected action when
the shape animation finished. Removing the React component and immediately
calling the picker did not wait for UIKit to dismiss the menu's native modal.
Files and Photos failed to appear; subsequent document requests could report
`PickingInProgressException` because the first request never completed.

`MorphingMenu` now sets its native modal's `visible` property to false after
the exit animation, then invokes `onClosed` only from iOS `onDismiss`. The
component stays mounted until that acknowledgement and consumes the completion
once. Android retains completion after the animation. The user confirmed that
both Files and Photos opened after installing this change alone.

**Camera in a window:** The same build still displayed a gray viewfinder, and
the shutter failed with `CameraImageCaptureException` at
`CameraPhotoCapture.swift:130`. Temporary native instrumentation measured:

| Layout | Window, points | Preview, points | Capture session running |
| --- | --- | --- | --- |
| Narrow window | 375 × 779 | 351 × 463.5 | false |
| Full-screen | 1210 × 834 | 440 × 504.5 | true |

The preview was attached to the visible window, had nonzero bounds and full
opacity, and had an enabled, active capture connection. The user confirmed
that expanding the app to full-screen restored the live camera. This isolated
the failure to iPad multitasking capture access, rather than a missing preview
or permission.

The existing pinned expo-camera patch now also enables
`isMultitaskingCameraAccessEnabled` during session configuration, before
capture starts, only if `isMultitaskingCameraAccessSupported` is true.
This follows [Apple's multitasking camera guidance](https://developer.apple.com/documentation/avkit/accessing-the-camera-while-multitasking-on-ipad).
The setting applies to both the composer camera and pairing QR scanning.
The Android preview-clipping patch remains in the same patch file.

iOS autolinking explicitly builds expo-camera from source; a precompiled
framework would bypass this patch. This requires a new signed native build.
No entitlement or background mode was added. The final generated scene delegate
is produced by the tracked `withSceneLifecycle.js`, without the earlier local
notification-forwarding experiments or temporary diagnostic code.

**Networking:** Issue #5's existing `app.json` change generates
`NSAppTransportSecurity = { NSAllowsArbitraryLoads: true }`. Expo introspection
and the signed release app's `Info.plist` both retained that value without
`NSAllowsLocalNetworking`. This report verifies the configuration; it does not
claim a new, independently reproduced ATS failure or a narrower network policy.

## Automated checks

- TypeScript type checking passed.
- All 83 mobile tests passed, including six new dismissal tests.
- The dismissal tests execute the real component with separate animation,
  React, and native-dismissal queues. Against the original `fc099fa` component,
  all four iOS cases fail because the next action runs before native dismissal;
  all six cases pass with the fix. Coverage includes both exit motions,
  Reduce Motion, exactly-once completion, and Android's completion path.
- Expo Doctor passed all 21 checks; iOS and Android exports succeeded.

## Final device verification

The final Release build compiled `CameraSessionManager.swift` from the patched
source and installed successfully on the same iPad. The user confirmed the
following requested check passed in the narrow window: live preview, shutter,
Retake, another capture and Use photo producing an attachment, followed by
switching away and back and checking Camera, Photos, and Files again.

All temporary native diagnostics were removed before that final build. The
app's generated scene delegate matches the tracked plugin. Its signed
`Info.plist` still contains the networking configuration documented above.

The camera's multitasking behavior needs a physical supported iPad. JavaScript
tests and simulator builds do not establish that hardware behavior. This was
a functional test on one M4 iPad, not a measurement of camera latency, energy,
or behavior on every supported iPhone/iPad model. The source-built pairing QR
module is included; a live QR scan was not separately exercised in this check.
