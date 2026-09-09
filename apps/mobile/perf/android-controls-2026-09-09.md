# Android custom controls

Android app dialogs, editable prompts, switches, stack headers, picker sheets,
loading indicators and pull-to-refresh visuals now use the Ink components.
iOS keeps native alerts, switches, headers and sheets. OS file access, sharing
and text input integration continue through their platform APIs.

Dialogs and sheets share the ellipsis menu's leading mass and following size
springs. The surface changes shape separately from its unscaled content. Exit
finishes before a dialog action or navigation removal executes. Reduced motion
uses a short fade. Android surfaces are opaque in both themes.

## Verification

An API 35 / arm64 Pixel 7 emulator on the M1 host ran the production Hermes
bundle in the existing 0.1.1 build 3 native runtime. For local testing, that
bundle replaced the embedded bundle in a copy of the APK, which was signed with
a temporary local test key. It was not a new official build. Tests connected
only to the isolated fixture over an ADB reverse tunnel.

Checked custom headers, connection/setup/permission sheets, compact and expanded
sheet sizes, close/Back/header-drag dismissal, and dismissal after a cold deep
link. The initial route is anchored to home so direct links can close correctly.
The compressed Android accessibility hierarchy exposes the active sheet without
the screen behind it. Switch state changes and pull-to-refresh were exercised;
the latter produced the expected refresh RPCs in the fixture.

Light and dark dialog checks covered a prefilled rename prompt, keyboard layout,
cancel without saving, and saving the edited name through the fixture RPC.
Destructive confirmations were canceled with both Cancel and Android Back.
Reduced-motion sheet opening and dismissal completed without leaving an overlay.
No React Native or Android runtime errors were recorded in these checks.

All 37 mobile tests, TypeScript, Expo Doctor's 21 checks, and Android/iOS
production exports passed. Dialog queue tests cover one-shot confirmation,
cancellation, edited values, nested dialogs, and queued requests.

These are functional and visual checks. Physical-device motion quality, frame
timing, CPU and energy were not measured; the emulator used software rendering.
The iOS native controls were retained and exported, but were not rerun on an iOS
device during this Android pass.
