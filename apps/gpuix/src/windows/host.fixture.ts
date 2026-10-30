// A window-registry host without a window, for `registry.test.ts`: claims a window and prints each focus request.
import { startWindowRegistry } from './registry.ts'
startWindowRegistry({ name: () => process.argv[2] ?? 'window', focus: () => console.log('focus') })
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 1 << 30)
console.log('ready')
