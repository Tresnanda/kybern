// A window-registry host without a window, for `registry.test.ts`: claims `argv[2]` and prints each focus request.
import { startWindowRegistry } from './registry.ts'
let environment = process.argv[2]!
startWindowRegistry({ environment: () => ({ id: environment, name: environment }), focus: () => console.log('focus') })
process.stdin.on('data', chunk => { environment = String(chunk).trim(); void import('./registry.ts').then(r => { r.publishWindow(); console.log('switched') }) })
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 1 << 30)
console.log('ready')
