// Pages for the inline visual checks (ADE-69): one with controls, one tall, one that asks for an answer. Written the way
// the agent guide asks: no title heading, no page background, theme variables for colour.

const BASE = `<style>
body{margin:0;font:13px/1.45 var(--font-sans);color:var(--foreground)}
.muted{color:var(--muted-foreground)}
button{font:inherit;color:inherit;background:transparent;border:1px solid var(--border);border-radius:7px;padding:3px 10px;cursor:pointer}
button[aria-pressed=true]{background:color-mix(in srgb,var(--foreground) 10%,transparent)}
</style>`

export const BUNDLE_PAGE = `<!doctype html><meta charset="utf-8">${BASE}<style>
.row{display:flex;align-items:center;gap:10px;margin:7px 0}.row span{width:92px}.bar{display:block;height:16px;border-radius:4px;background:var(--chart-1);transition:width .2s}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.seg{display:flex;gap:4px}
</style>
<div class="top"><span class="muted">Kilobytes per route, production build</span><div class="seg"><button id="gzip" aria-pressed="true">Gzip</button><button id="raw" aria-pressed="false">Raw</button></div></div>
<div id="rows"></div>
<script>
const data=[["/",182,612],["/settings",96,301],["/threads/:id",241,820],["/notes",74,233],["/tasks",88,270]];
let raw=false;function draw(){document.getElementById('rows').innerHTML=data.map(([r,g,w])=>{const v=raw?w:g;return '<div class=row><span>'+r+'</span><i class=bar style="width:'+Math.round(v/(raw?820:241)*420)+'px"></i><span class=muted>'+v+' kB</span></div>'}).join('')}
for(const id of ['gzip','raw'])document.getElementById(id).onclick=()=>{raw=id==='raw';document.getElementById('gzip').setAttribute('aria-pressed',String(!raw));document.getElementById('raw').setAttribute('aria-pressed',String(raw));draw()};draw();
</script>`

export const CHECKLIST_PAGE = `<!doctype html><meta charset="utf-8">${BASE}<style>
li{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)}ul{list-style:none;margin:0;padding:0}
input{width:16px;height:16px;margin:0}.tag{margin-left:auto}
</style><p class="muted" style="margin:0 0 6px">Every step before tagging v0.14.0</p><ul>${Array.from({ length: 26 }, (_, i) => `<li><input type="checkbox" ${i < 7 ? 'checked' : ''}><span>Step ${i + 1}: ${['Run the Rust tests', 'Update protocol snapshots', 'Check GPUIX typecheck', 'Screenshot dark and glass', 'Bump the version', 'Write the changelog'][i % 6]}</span><span class="tag muted">${i < 7 ? 'done' : 'open'}</span></li>`).join('')}</ul>`

export const LAYOUT_PAGE = `<!doctype html><meta charset="utf-8">${BASE}<style>
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.tile{border:1px solid var(--border);border-radius:10px;padding:10px;cursor:pointer;transition:opacity .15s}
.tile[aria-pressed=true]{border-color:var(--chart-1);box-shadow:0 0 0 1px var(--chart-1)}
.thumb{height:92px;border-radius:6px;display:flex;gap:4px;padding:6px;background:color-mix(in srgb,var(--foreground) 5%,transparent)}
.thumb i{display:block;border-radius:3px;background:color-mix(in srgb,var(--foreground) 16%,transparent)}
.name{margin-top:8px;font-weight:600}.done .tile:not([aria-pressed=true]){opacity:.42}
</style><div class="grid" id="grid">
<div class="tile" role="button" data-v="A" aria-pressed="false"><div class="thumb"><i style="flex:1"></i></div><div class="name">A · Single column</div><div class="muted">Photos stacked, EXIF below</div></div>
<div class="tile" role="button" data-v="B" aria-pressed="false"><div class="thumb"><i style="flex:2"></i><i style="flex:1"></i></div><div class="name">B · Side panel</div><div class="muted">EXIF panel on the right</div></div>
<div class="tile" role="button" data-v="C" aria-pressed="false"><div class="thumb" style="flex-wrap:wrap"><i style="width:47%;height:38px"></i><i style="width:47%;height:38px"></i><i style="width:47%;height:38px"></i><i style="width:47%;height:38px"></i></div><div class="name">C · Grid</div><div class="muted">Four up, details on hover</div></div>
</div><script>
const names={A:'Layout A · Single column',B:'Layout B · Side panel',C:'Layout C · Grid'};
function pick(v){for(const t of document.querySelectorAll('.tile'))t.setAttribute('aria-pressed',String(t.dataset.v===v))}
for(const t of document.querySelectorAll('.tile'))t.onclick=()=>{if(document.body.classList.contains('done'))return;pick(t.dataset.v);kybern.answer.draft({layout:t.dataset.v},{label:names[t.dataset.v]})};
addEventListener('kybern-answer-state',e=>{if(e.detail.state==='answered'&&e.detail.answer){pick(e.detail.answer.layout);document.getElementById('grid').classList.add('done');document.body.classList.add('done')}});
</script>`

export const LAYOUT_SCHEMA = { type: 'object', properties: { layout: { enum: ['A', 'B', 'C'] } }, required: ['layout'] }
