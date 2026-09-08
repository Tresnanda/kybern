// Rebuild the offline terminal after updating desktop's pinned xterm packages.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "../desktop/package.json"));
const xterm = dirname(dirname(require.resolve("@xterm/xterm")));
const fit = require.resolve("@xterm/addon-fit");
const script = (path) =>
  readFileSync(path, "utf8").replaceAll("</script", "<\\/script");
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:"><style>html,body,#terminal{margin:0;width:100%;height:100%;overflow:hidden;background:#FFFFFF}#terminal{width:calc(100% - 36px);height:calc(100% - 24px);margin:12px 18px;box-sizing:border-box}${readFileSync(resolve(xterm, "css/xterm.css"), "utf8")}</style></head><body><div id="terminal"></div><script>${script(resolve(xterm, "lib/xterm.js"))}\n${script(fit)}\n${script(resolve(root, "scripts/terminal-bridge.js"))}</script></body></html>`;
writeFileSync(
  resolve(root, "src/generated/terminal.json"),
  JSON.stringify(html),
);
writeFileSync(
  resolve(root, "src/generated/XTERM-LICENSE.txt"),
  readFileSync(resolve(xterm, "LICENSE")),
);
