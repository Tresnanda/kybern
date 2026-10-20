// The older dock fixture predates asynchronous environment resolution. Keep
// its assertions unchanged and wait for the scratch client before wrapping it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
Bun.plugin({ name: 'dock-fixture-client-ready', setup(build) {
  build.onLoad({ filter: /\/src\/dock\/verify-fixture\.tsx$/ }, args => {
    const source = readFileSync(args.path, 'utf8')
    const anchor = 'const client = getClient()!, call = client.call.bind(client)'
    assert.ok(source.includes(anchor), 'dock fixture client anchor changed')
    return { contents: source.replace(anchor, `while (!getClient()) await Bun.sleep(1)\n${anchor}`), loader: 'tsx' }
  })
} })
