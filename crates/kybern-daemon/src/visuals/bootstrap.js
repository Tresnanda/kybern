(function () {
  const style = document.getElementById("kybern-visual-theme");
  const base = "html{background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;scrollbar-width:none}html::-webkit-scrollbar{display:none}body{margin:0}code,pre,kbd{font-family:var(--font-mono)}";
  function theme(value) {
    if (!value || !value.variables || typeof value.variables !== "object") return;
    let css = ":root{color-scheme:" + (value.appearance === "light" ? "light" : "dark") + ";";
    for (const key in value.variables) if (/^--[a-z0-9-]+$/.test(key) && typeof value.variables[key] === "string") css += key + ":" + value.variables[key].replace(/[;{}<>]/g, "") + ";";
    style.textContent = css + "}" + base;
  }
  try { const match = /[#&]kybern-theme=([^&]*)/.exec(location.hash); if (match) theme(JSON.parse(decodeURIComponent(match[1]))); } catch (_) {}
  let active = true;
  const nativeRaf = window.requestAnimationFrame.bind(window), nativeCancelRaf = window.cancelAnimationFrame.bind(window);
  const rafs = new Map(); let frameId = 0;
  window.requestAnimationFrame = function (callback) { const id = ++frameId; const entry = { callback, native: null }; rafs.set(id, entry); if (active) entry.native = nativeRaf(function (t) { rafs.delete(id); callback(t); }); return id; };
  window.cancelAnimationFrame = function (id) { const entry = rafs.get(id); if (entry && entry.native !== null) nativeCancelRaf(entry.native); rafs.delete(id); };
  const nativeInterval = window.setInterval.bind(window), nativeClearInterval = window.clearInterval.bind(window);
  const intervals = new Map(); let intervalId = 1000000000;
  window.setInterval = function (callback, delay, ...args) { const id = ++intervalId; const entry = { callback: () => typeof callback === "function" ? callback(...args) : undefined, delay: Math.max(16, Number(delay) || 0), native: null }; intervals.set(id, entry); if (active) entry.native = nativeInterval(entry.callback, entry.delay); return id; };
  window.clearInterval = function (id) { const entry = intervals.get(id); if (entry) { if (entry.native !== null) nativeClearInterval(entry.native); intervals.delete(id); } else nativeClearInterval(id); };
  function visibility(visible) {
    if (visible === active) return; active = visible;
    document.documentElement.dataset.kybernActive = String(active);
    for (const [id, entry] of rafs) { if (!active && entry.native !== null) { nativeCancelRaf(entry.native); entry.native = null; } else if (active && entry.native === null) entry.native = nativeRaf(t => { rafs.delete(id); entry.callback(t); }); }
    for (const entry of intervals.values()) { if (!active && entry.native !== null) { nativeClearInterval(entry.native); entry.native = null; } else if (active && entry.native === null) entry.native = nativeInterval(entry.callback, entry.delay); }
    for (const animation of document.getAnimations()) { if (!active && animation.playState === "running") { animation.pause(); animation.__kybernPaused = true; } else if (active && animation.__kybernPaused) { animation.__kybernPaused = false; animation.play(); } }
    for (const media of document.querySelectorAll("video,audio")) if (!active) media.pause();
    window.dispatchEvent(new CustomEvent("kybern-visibility", { detail: { visible: active } }));
  }
  window.addEventListener("message", e => { if (e.source !== window.parent) return; const data = e.data; if (!data || data.kind !== "kybern-visual-host") return; theme(data.theme); if (typeof data.visible === "boolean") visibility(data.visible); });
  document.addEventListener("click", e => {
    const link = e.isTrusted && e.composedPath().find(node => node && node.matches && node.matches("a[href]"));
    if (!link || window.parent === window) return;
    try { const url = new URL(link.getAttribute("href"), location.href); if (!/^https?:$/.test(url.protocol) || url.username || url.password) return; e.preventDefault(); window.parent.postMessage({ kind: "kybern-visual-link", url: url.href }, "*"); } catch (_) {}
  }, true);
  let height = 0, scheduled = false;
  function measure() { scheduled = false; const body = document.body; if (!body) return; const next = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height)); if (next > 0 && next !== height) { height = next; window.parent.postMessage({ kind: "kybern-visual-size", height }, "*"); } }
  function schedule() { if (!scheduled) { scheduled = true; nativeRaf(measure); } }
  const observer = new ResizeObserver(schedule);
  document.addEventListener("DOMContentLoaded", () => { if (document.body) observer.observe(document.body); schedule(); });
  window.addEventListener("load", schedule);
})();
