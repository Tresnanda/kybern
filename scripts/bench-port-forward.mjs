// Creates an isolated 300-module Vite workload for the port-forward benchmark.
// Run: node scripts/bench-port-forward.mjs /absolute/scratch/folder [port]
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(process.argv[2] ?? '/tmp/kybern-port-benchmark')
const port = Number(process.argv[3] ?? 58173)
await mkdir(join(root, 'src'), { recursive: true })
await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { vite: '8.0.10' } }, null, 2))
await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>Kybern 300 module benchmark</title></head><body><main id="app">Loading 300 modules</main><script type="module" src="/src/main.js"></script></body></html>')
const moduleSource = (i, version = 0) => `export const value = ${version};\nexport const payload = ${JSON.stringify('module-' + i + ':' + 'x'.repeat(2048))};\n${i === 0 ? 'window.hmrVersion = value; window.hmrAppliedAt = performance.now(); if (import.meta.hot) import.meta.hot.accept();' : ''}\n`
await Promise.all(Array.from({ length: 300 }, (_, i) => writeFile(join(root, 'src', `m${i}.js`), moduleSource(i))))
await writeFile(join(root, 'src/main.js'), Array.from({ length: 300 }, (_, i) => `import { payload as p${i} } from './m${i}.js';`).join('\n') + '\ndocument.getElementById("app").textContent = "Loaded 300 modules: " + [' + Array.from({ length: 300 }, (_, i) => `p${i}.length`).join(',') + '].reduce((a,b)=>a+b,0); window.appReady = performance.now();\n')
await writeFile(join(root, 'server.mjs'), `import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
const root = import.meta.dirname;
const source = ${moduleSource.toString()};
const server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: ${port}, strictPort: true }, plugins: [{ name: 'bench-control', configureServer(server) {
  server.middlewares.use('/__bench/cold', (_req, res) => { server.environments.client.moduleGraph.invalidateAll(); res.end('invalidated'); });
  server.middlewares.use('/__bench/change', async (req, res) => {
    const version = Number(new URL(req.url, 'http://localhost').searchParams.get('version'));
    if (!Number.isSafeInteger(version)) { res.statusCode = 400; res.end(); return; }
    await writeFile(root + '/src/m0.js', source(0, version)); res.end('changed');
  });
} }] });
await server.listen();
console.log('Vite benchmark ready on http://127.0.0.1:${port}');
process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
`)
console.log(JSON.stringify({ root, port, modules: 300, bytesPerModule: 2048 }))
