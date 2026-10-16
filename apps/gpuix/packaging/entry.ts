import path from 'node:path'
const resources = path.resolve(path.dirname(process.execPath), '../Resources')
process.env.KYBERN_GPUIX_RESOURCES = resources
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.join(resources, 'gpuix-native.darwin-arm64.node')
process.env.KYBERN_GPUIX_NATIVE = 'local'
process.env.KYBERND ??= path.resolve(resources, '../MacOS/kybernd')
process.env.KYBERN_BUNDLED_CLI ??= path.resolve(resources, '../MacOS/kybern')
process.env.KYBERN_GPUIX_VERSION = (await Bun.file(path.join(resources, 'version')).text()).trim()
await import('../src/main.tsx')
if (process.env.KYBERN_GPUIX_NOTIFICATION_TEST === '1') {
  const { notifications } = await import('../src/native/notifications.ts')
  notifications.onClick(id => console.error('[notification click]', id))
  console.error('[notification permission]', await notifications.requestPermission())
  const post = async () => console.error('[notification post]', await notifications.post({id: `package-test-${Date.now()}`, title: 'Kybern GPUIX', body: 'Click to verify the notification callback.'}))
  await post()
}
