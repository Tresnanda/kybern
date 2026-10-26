import { copyFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { COMPANION_CFLAGS } from '../scripts/companion-flags.ts'
// The embedded web view host `webview.ts` loads: `build/kybern-webview.dylib` from `webview.m` (WKWebView) on macOS,
// `build/kybern-webview.dll` from the `webview-win` crate (WebView2) on Windows.
const root = import.meta.dir
mkdirSync(path.join(root, 'build'), { recursive: true })
if (process.platform === 'win32') {
  const target = path.join(root, 'build/webview-win-target')
  execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(root, 'webview-win/Cargo.toml')], { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0', RUSTC_WRAPPER: '' } })
  copyFileSync(path.join(target, 'release/kybern_webview.dll'), path.join(root, 'build/kybern-webview.dll'))
} else {
  execFileSync('clang', ['-dynamiclib', ...COMPANION_CFLAGS, '-framework', 'Cocoa', '-framework', 'WebKit', '-framework', 'QuartzCore', path.join(root, 'webview.m'), '-o', path.join(root, 'build/kybern-webview.dylib')], { stdio: 'inherit' })
  execFileSync('codesign', ['--force', '--sign', '-', path.join(root, 'build/kybern-webview.dylib')], { stdio: 'inherit' })
}
