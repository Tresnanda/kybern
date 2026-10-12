// Serves the visuals-bounce fixture's frame documents the way the daemon serves a ticket: its CSP and
// its real bootstrap. A separate process, because the runner blocks its own event loop while it
// builds and while the native window runs. Prints `{"port":N}` once listening.
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { bootstrapper, pages, policy } from "../perf/visuals-bounce-pages.mjs"

const repo = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const wrap = bootstrapper(repo), csp = policy(repo)
const server = createServer((request, response) => {
  const page = /^\/visual-frame\/([a-z]+)\//.exec(request.url ?? "")?.[1]
  if (!page || !pages[page]) { response.writeHead(404); response.end("missing"); return }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "cross-origin" })
  response.end(wrap(pages[page]))
})
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port })))
