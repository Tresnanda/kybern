import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { COMPANION_CFLAGS } from '../scripts/companion-flags.ts'
const root = import.meta.dir
mkdirSync(path.join(root, 'build'), { recursive: true })
execFileSync('clang', ['-dynamiclib', ...COMPANION_CFLAGS, '-framework', 'Cocoa', '-framework', 'WebKit', '-framework', 'QuartzCore', path.join(root, 'webview.m'), '-o', path.join(root, 'build/kybern-webview.dylib')], { stdio: 'inherit' })
execFileSync('codesign', ['--force', '--sign', '-', path.join(root, 'build/kybern-webview.dylib')], { stdio: 'inherit' })
