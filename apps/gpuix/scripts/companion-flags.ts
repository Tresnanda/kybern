/**
 * clang flags for the small Objective-C companions (`kybern-webview.dylib`, `notifications.dylib`).
 * They are universal, so one build serves the arm64 and x86_64 apps, and they target the app's
 * `LSMinimumSystemVersion`: clang otherwise stamps the build machine's macOS as the minimum,
 * and dyld refuses the library on anything older.
 */
export const COMPANION_CFLAGS = ['-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0', '-fobjc-arc', '-fblocks']
