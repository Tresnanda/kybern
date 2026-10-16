import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
const root = import.meta.dir
mkdirSync(path.join(root, 'build'), { recursive: true })
execFileSync('clang', ['-dynamiclib', '-fobjc-arc', '-fblocks', '-framework', 'Cocoa', '-framework', 'WebKit', '-framework', 'QuartzCore', path.join(root, 'webview.m'), '-o', path.join(root, 'build/kybern-webview.dylib')], { stdio: 'inherit' })
execFileSync('codesign', ['--force', '--sign', '-', path.join(root, 'build/kybern-webview.dylib')], { stdio: 'inherit' })
