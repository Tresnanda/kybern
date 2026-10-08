// Scratch servers for the `preview` rendering fixture. Prints one JSON line with the ports, then
// serves until killed. Loopback only. `control` answers GET /start-closed to bring up the
// "closed" port later (the Waiting state must then load the page by itself).
import { createServer } from "node:http"
import { createHash } from "node:crypto"

const page = (title, body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
:root{color-scheme:light dark}body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#fff;color:#1c1c1e}
@media(prefers-color-scheme:dark){body{background:#17171a;color:#ececf0}}h1{font-size:20px;margin:0 0 8px}.card{padding:12px 14px;border-radius:10px;background:rgba(127,127,127,.12);margin-top:12px}</style></head><body>${body}<script>${script}</script></body></html>`

const report = `
let n=0;const post=(extra)=>parent.postMessage({fixture:'kybern-preview',n,w:innerWidth,h:innerHeight,...extra},'*');
setInterval(()=>{n++;document.getElementById('n').textContent=n},100);
try{localStorage.setItem('k','v');post({storage:localStorage.getItem('k')==='v'})}catch(e){post({storage:false})}
let topBlocked=false;try{void top.location.href}catch{topBlocked=true}
let topNav='allowed';try{top.location='https://example.test/'}catch{topNav='blocked'}
const popup=window.open('about:blank');
post({topBlocked,topNav,popup:!!popup});
addEventListener('message',e=>{if(e.data&&e.data.fixture==='kybern-preview-command')post({reply:e.data.action})});
addEventListener('resize',()=>post({}));
setInterval(()=>post({}),400);
`

function frameServer(headers = {}, wsEcho = false) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/@vite/client")) { res.writeHead(200, { "content-type": "text/javascript" }); res.end("window.__vite=1"); return }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers })
    res.end(page("Dashboard", `<h1>Dashboard</h1><p>Live counter: <b id="n">0</b></p><div class="card">Vite-like dev server. Path: ${req.url}</div><script type="module" src="/@vite/client"></script>`,
      report + (wsEcho ? `
const ws=new WebSocket('ws://'+location.host+'/','vite-hmr');ws.onopen=()=>{ws.send('ping');post({ws:'open',protocol:ws.protocol})};ws.onmessage=e=>post({ws:'message',data:String(e.data)});ws.onclose=()=>post({ws:'closed'});` : "")))
  })
  if (wsEcho) {
    server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"]
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
      socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, ...(protocols.includes("vite-hmr") ? ["Sec-WebSocket-Protocol: vite-hmr"] : []), "", ""].join("\r\n"))
      const frame = (text) => { const body = Buffer.from(text); return Buffer.concat([Buffer.from([0x81, body.length]), body]) }
      socket.write(frame('{"type":"connected"}'))
      socket.on("data", (buffer) => {
        // Client frames are masked; decode text frames up to 125 bytes and echo them back.
        const length = buffer[1] & 0x7f; const mask = buffer.subarray(2, 6); const payload = Buffer.from(buffer.subarray(6, 6 + length))
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
        if ((buffer[0] & 0x0f) === 8) { socket.end(); return }
        socket.write(frame(`echo:${payload.toString()}`))
      })
      socket.on("error", () => {})
    })
  }
  return server
}

const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)))

const vite = frameServer({}, true)
const xfo = frameServer({ "x-frame-options": "SAMEORIGIN" })
const probe = frameServer()
const ports = { vite: await listen(vite), xfo: await listen(xfo), probe: await listen(probe) }
// A port that is closed now and can be opened on request.
const holder = createServer(); ports.closed = await listen(holder); await new Promise((resolve) => holder.close(resolve))
let late
const control = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*")
  if (req.url === "/start-closed" && !late) { late = frameServer({}, true); await listen(late, ports.closed) }
  if (req.url === "/stop-closed" && late) { late.closeAllConnections(); late.close(); late = undefined }
  res.end("ok")
})
ports.control = await listen(control)
console.log(JSON.stringify(ports))
process.on("SIGTERM", () => process.exit(0))
setInterval(() => {}, 1 << 30)
