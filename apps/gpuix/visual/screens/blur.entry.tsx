// Keep the test window opaque while allowing scene-local backdrop materials.
process.env.KYBERN_OPAQUE = '0'
await import('../../src/main.tsx')
export {}
