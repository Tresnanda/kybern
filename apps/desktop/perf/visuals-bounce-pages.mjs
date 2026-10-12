// Frame documents for the visuals-bounce fixture. The runner serves them the way the daemon
// serves a ticket: its real CSP and the real bootstrap (prepare.rs markup + bootstrap.js).
import { readFileSync } from "node:fs"
import path from "node:path"

/** The daemon's `bootstrap()` markup, read from source so the fixture cannot drift from it. */
export function bootstrapper(repo) {
  const source = readFileSync(path.join(repo, "crates/kybern-daemon/src/visuals/prepare.rs"), "utf8")
  const script = readFileSync(path.join(repo, "crates/kybern-daemon/src/visuals/bootstrap.js"), "utf8")
  const literal = /pub fn bootstrap[\s\S]*?format!\(\s*"((?:[^"\\]|\\.)*)"/.exec(source)?.[1]
  if (!literal) throw new Error("Could not read the daemon bootstrap markup")
  const markup = literal.replaceAll('\\"', '"').replaceAll("{{", "{").replaceAll("}}", "}").replace("{}", () => script)
  return html => `<!doctype html><html><head>${markup}</head>${html}`
}
export function policy(repo) {
  const source = readFileSync(path.join(repo, "crates/kybern-daemon/src/visuals.rs"), "utf8")
  const value = /pub\(super\) const POLICY: &str = "([^"]+)"/.exec(source)?.[1]
  if (!value) throw new Error("Could not read the visual CSP")
  return value
}

// In-frame probe: answers the host with layout facts the assertions need.
const probe = `<script>(function(){
  var s={hostMsgs:0,themeMsgs:0,themeWrites:0,visFlips:0};
  addEventListener('message',function(e){if(e.source===parent&&e.data&&e.data.kind==='kybern-visual-host'){s.hostMsgs++;if(e.data.theme)s.themeMsgs++}});
  addEventListener('kybern-visibility',function(){s.visFlips++});
  document.addEventListener('DOMContentLoaded',function(){
    var st=document.getElementById('kybern-visual-theme');
    new MutationObserver(function(){s.themeWrites++}).observe(st,{childList:true,characterData:true,subtree:true});
  });
  addEventListener('message',function(e){if(!e.data||e.data.fixture!=='bounce-probe')return;
    var de=document.documentElement,bars=[];
    document.querySelectorAll('[data-bar]').forEach(function(el){var c=getComputedStyle(el);bars.push({id:el.dataset.bar,x:el.offsetHeight-el.clientHeight-parseFloat(c.borderTopWidth)-parseFloat(c.borderBottomWidth),y:el.offsetWidth-el.clientWidth-parseFloat(c.borderLeftWidth)-parseFloat(c.borderRightWidth)})});
    parent.postMessage({fixture:'bounce-report',id:document.title,hostMsgs:s.hostMsgs,themeMsgs:s.themeMsgs,themeWrites:s.themeWrites,visFlips:s.visFlips,
      docScrollHeight:de.scrollHeight,docClientHeight:de.clientHeight,innerHeight:innerHeight,innerWidth:innerWidth,rootHeight:de.getBoundingClientRect().height,bodyHeight:document.body.getBoundingClientRect().height,bars:bars},'*')});
})();</script>`

const rows = n => Array.from({ length: n }, (_, i) => `<tr><td>Row ${i + 1}</td><td>${(i * 37) % 100}</td></tr>`).join("")
export const pages = {
  basic: `<head><title>basic</title><style>svg{display:block;width:100%;height:100px}table{border-collapse:collapse;width:100%}td{padding:6px 0;border-bottom:1px solid var(--border)}</style></head><body>${probe}<h3>Regional comparison</h3><svg viewBox="0 0 300 100"><rect width="80" height="80" y="20" fill="var(--chart-1)"/><rect x="100" width="80" height="55" y="45" fill="var(--chart-2)"/></svg><table><tr><td>North</td><td>80</td></tr><tr><td>South</td><td>55</td></tr></table></body>`,
  // The first and last child margins collapse through body, so body's own box is 64px short of the page.
  margins: `<head><title>margins</title><style>h2{margin:40px 0 12px}p{margin:0 0 24px}.last{margin-bottom:40px}</style></head><body>${probe}<h2>Collapsed margins</h2><p>Body text.</p><p class="last">The last paragraph keeps a bottom margin.</p></body>`,
  // Overflowing blocks inside the page: the scrollbars the bootstrap stylesheet styles. #own sets its own.
  scroll: `<head><title>scroll</title><style>body{padding:16px}pre{margin:0 0 12px;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);overflow:auto;font:12px/1.5 var(--font-mono)}.list{height:120px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}table{width:100%;border-collapse:collapse}td{padding:6px 10px;border-bottom:1px solid var(--border)}#own{height:60px;overflow:auto;margin-top:12px;border:1px solid var(--border)}#own::-webkit-scrollbar{width:4px;height:4px}#own::-webkit-scrollbar-thumb{background:#e11d48}</style></head><body>${probe}<pre data-bar="pre">${"const reallyLongIdentifierName = computeSomethingExpensive(argumentNumberOne, argumentNumberTwo, argumentNumberThree);".repeat(3)}\nsecond line</pre><div class="list" data-bar="list"><table>${rows(14)}</table></div><div id="own" data-bar="own"><div style="width:900px;height:200px"></div></div></body>`,
}
