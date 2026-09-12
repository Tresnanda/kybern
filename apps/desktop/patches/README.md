# Tauri event cleanup

`@tauri-apps/api@2.11.1` is patched for
[tauri-apps/tauri#15799](https://github.com/tauri-apps/tauri/issues/15799).
Tauri 2.11.5 can resolve `listen()` before its registration script reaches
the webview. CloseGuard can unmount during startup in that gap. The upstream
cleanup reads `listeners[eventId].handlerId`, throws, and never unregisters
the callback or native listener.

The patch retains the callback ID from `transformCallback`, releases it
directly, and sends the normal native unlisten command. Cleanup shares one
promise so repeated calls cannot unregister twice. Failed registration also
releases the callback. `once()` uses the same cleanup, including when the event
arrives before the registration reply. Both ESM and CommonJS builds are patched;
no public API changes are needed.

`tauriEvents.test.mjs` exercises the installed package and actual Window API
against a simulated native bridge with independently delayed registration.
It reproduces the original failure and checks cleanup, remount delivery,
registration errors, and once-only listeners. It runs with `pnpm test`.

Remove the patch when upgrading to a Tauri/API combination that fixes the
registration race and callback cleanup, keeping the regression checks. The
version-specific `patchedDependencies` entry intentionally requires review
when the API dependency changes.
