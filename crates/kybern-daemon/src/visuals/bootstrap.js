(function () {
  const style = document.getElementById("kybern-visual-theme");
  const base = "html{background:transparent;color:var(--foreground);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;scrollbar-width:none}html::-webkit-scrollbar{display:none}body{margin:0}code,pre,kbd{font-family:var(--font-mono)}";
  // The app's own scrollbars (styles/kit.css): 10px track, transparent, a 6px rounded thumb that
  // floats 2px from the edge and darkens on hover. Only `*::-webkit-*` rules and no standard
  // `scrollbar-*` property, so any scrollbar styling in the page itself wins at equal specificity
  // (the page's styles come later) and an explicit `scrollbar-width`/`scrollbar-color` replaces it.
  function scrollbars(light) {
    const thumb = "color-mix(in srgb,var(--foreground) " + (light ? 10 : 7) + "%,transparent)", hover = "color-mix(in srgb,var(--foreground) " + (light ? 18 : 14) + "%,transparent)";
    return "*::-webkit-scrollbar{width:10px;height:10px}*::-webkit-scrollbar-track,*::-webkit-scrollbar-corner{background:transparent}*::-webkit-scrollbar-thumb{background-color:" + thumb + ";border:2px solid transparent;background-clip:padding-box;border-radius:999px}*::-webkit-scrollbar-thumb:hover{background-color:" + hover + "}";
  }
  // The theme is re-sent whenever the host re-checks visibility; identical CSS is not rewritten, so
  // the page's style observers, restyles and charts that re-read colors stay quiet.
  let applied = "";
  function theme(value) {
    if (!value || !value.variables || typeof value.variables !== "object") return;
    let css = ":root{color-scheme:" + (value.appearance === "light" ? "light" : "dark") + ";";
    for (const key in value.variables) if (/^--[a-z0-9-]+$/.test(key) && typeof value.variables[key] === "string") css += key + ":" + value.variables[key].replace(/[;{}<>]/g, "") + ";";
    css += "}" + base + scrollbars(value.appearance === "light");
    if (css === applied) return;
    applied = css;
    style.textContent = css;
  }
  try { const match = /[#&]kybern-theme=([^&]*)/.exec(location.hash); if (match) theme(JSON.parse(decodeURIComponent(match[1]))); } catch (_) {}
  let active = true;
  // CSS-created animations need a rule, including those first created while
  // hidden. Removing the gate restores the page's own paused/running choices.
  const visibilityStyle = document.createElement("style");
  const hidden = 'html[data-kybern-active="false"]';
  visibilityStyle.textContent = [hidden, `${hidden} *`, `${hidden}::before`, `${hidden}::after`, `${hidden} *::before`, `${hidden} *::after`].join(",") + "{animation-play-state:paused!important}";
  document.head.appendChild(visibilityStyle);
  const pausedAnimations = new Set();
  const animationPrototype = window.Animation && window.Animation.prototype;
  const nativeAnimationPause = animationPrototype && animationPrototype.pause;
  const nativeAnimationPlay = animationPrototype && animationPrototype.play;
  function pauseAnimation(animation, cssGate = true) {
    if (cssGate && window.CSSAnimation && animation instanceof window.CSSAnimation) return;
    if (animation.playState === "running") {
      pausedAnimations.add(animation);
      if (nativeAnimationPause) nativeAnimationPause.call(animation); else animation.pause();
    }
  }
  if (animationPrototype) {
    for (const name of ["pause", "cancel", "finish"]) {
      const native = animationPrototype[name];
      if (native) animationPrototype[name] = function (...args) { pausedAnimations.delete(this); return native.apply(this, args); };
    }
    for (const name of ["play", "reverse"]) {
      const native = animationPrototype[name];
      if (native) animationPrototype[name] = function (...args) { const result = native.apply(this, args); if (!active) pauseAnimation(this, false); return result; };
    }
  }
  if (window.Element && window.Element.prototype.animate) {
    const nativeAnimate = window.Element.prototype.animate;
    window.Element.prototype.animate = function (...args) { const animation = nativeAnimate.apply(this, args); if (!active) pauseAnimation(animation, false); return animation; };
  }
  const nativeRaf = window.requestAnimationFrame.bind(window), nativeCancelRaf = window.cancelAnimationFrame.bind(window);
  const rafs = new Map(); let frameId = 0;
  window.requestAnimationFrame = function (callback) { const id = ++frameId; const entry = { callback, native: null }; rafs.set(id, entry); if (active) entry.native = nativeRaf(function (t) { rafs.delete(id); callback(t); }); return id; };
  window.cancelAnimationFrame = function (id) { const entry = rafs.get(id); if (entry && entry.native !== null) nativeCancelRaf(entry.native); rafs.delete(id); };
  const nativeInterval = window.setInterval.bind(window), nativeClearInterval = window.clearInterval.bind(window);
  const intervals = new Map(); let intervalId = 1000000000;
  window.setInterval = function (callback, delay, ...args) { const id = ++intervalId; const entry = { callback: () => typeof callback === "function" ? callback(...args) : undefined, delay: Math.max(16, Number(delay) || 0), native: null }; intervals.set(id, entry); if (active) entry.native = nativeInterval(entry.callback, entry.delay); return id; };
  window.clearInterval = function (id) { const entry = intervals.get(id); if (entry) { if (entry.native !== null) nativeClearInterval(entry.native); intervals.delete(id); } else nativeClearInterval(id); };
  function visibility(visible) {
    const changed = visible !== active; active = visible;
    document.documentElement.dataset.kybernActive = String(active);
    for (const [id, entry] of rafs) { if (!active && entry.native !== null) { nativeCancelRaf(entry.native); entry.native = null; } else if (active && entry.native === null) entry.native = nativeRaf(t => { rafs.delete(id); entry.callback(t); }); }
    for (const entry of intervals.values()) { if (!active && entry.native !== null) { nativeClearInterval(entry.native); entry.native = null; } else if (active && entry.native === null) entry.native = nativeInterval(entry.callback, entry.delay); }
    if (!active) for (const animation of document.getAnimations()) pauseAnimation(animation);
    else {
      for (const animation of pausedAnimations) if (animation.playState === "paused") { if (nativeAnimationPlay) nativeAnimationPlay.call(animation); else animation.play(); }
      pausedAnimations.clear();
    }
    for (const media of document.querySelectorAll("video,audio")) if (!active) media.pause();
    if (changed) window.dispatchEvent(new CustomEvent("kybern-visibility", { detail: { visible: active } }));
  }
  // Visuals that ask: the page drafts an answer, Kybern draws the send button and reports the outcome back.
  let answerState = { state: "waiting", answer: undefined };
  function announce(next) {
    answerState = { state: String(next.state || "waiting"), answer: next.answer };
    document.documentElement.dataset.kybernAnswer = answerState.state;
    window.dispatchEvent(new CustomEvent("kybern-answer-state", { detail: { state: answerState.state, answer: answerState.answer } }));
  }
  try { const match = /[#&]kybern-lock=([^&]*)/.exec(location.hash); if (match) { const lock = JSON.parse(decodeURIComponent(match[1])); answerState = { state: String(lock.state || "answered"), answer: lock.answer }; document.addEventListener("DOMContentLoaded", () => announce(answerState)); } } catch (_) {}
  function post(data) { if (window.parent !== window) window.parent.postMessage(data, "*"); }
  const answer = Object.freeze({
    draft(value, options) {
      let json; try { json = JSON.stringify(value); } catch (_) { return false; }
      if (json === undefined || json.length > 8192) return false;
      const label = options && typeof options.label === "string" ? options.label.slice(0, 120) : undefined;
      post({ kind: "kybern-visual-draft", value: JSON.parse(json), label });
      return true;
    },
    clear() { post({ kind: "kybern-visual-draft", value: null }); },
    submit() { post({ kind: "kybern-visual-submit" }); },
    get state() { return answerState.state; },
    get answer() { return answerState.answer; },
  });
  try { Object.defineProperty(window, "kybern", { value: Object.freeze({ answer }), configurable: false, writable: false }); } catch (_) {}
  const typing = el => !!(el && el.closest && el.closest("input,textarea,select,[contenteditable],[contenteditable=true]"));
  document.addEventListener("keydown", e => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === "Escape") post({ kind: "kybern-visual-escape" });
    else if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) post({ kind: "kybern-visual-submit" });
  });
  // A click on the picture, replayed where it landed once the live page is ready.
  function replay(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el === document.documentElement || el === document.body) return;
    if (typing(el) && el.focus) { el.focus(); return; }
    const target = el.closest("button,a[href],input,select,summary,label,[role],[onclick],[data-kybern-id]") || el;
    if (target.click) target.click();
  }
  window.addEventListener("message", e => {
    if (e.source !== window.parent) return;
    const data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.kind === "kybern-visual-host") { theme(data.theme); if (typeof data.visible === "boolean") visibility(data.visible); }
    else if (data.kind === "kybern-visual-lock") announce(data);
    else if (data.kind === "kybern-visual-click" && Number.isFinite(data.x) && Number.isFinite(data.y)) replay(data.x, data.y);
    else if (data.kind === "kybern-visual-select" && Number.isInteger(data.index)) window.dispatchEvent(new CustomEvent("kybern-answer-select", { detail: { index: data.index } }));
  });
  document.addEventListener("click", e => {
    const link = e.isTrusted && e.composedPath().find(node => node && node.matches && node.matches("a[href]"));
    if (!link || window.parent === window) return;
    try { const url = new URL(link.getAttribute("href"), location.href); if (!/^https?:$/.test(url.protocol) || url.username || url.password) return; e.preventDefault(); window.parent.postMessage({ kind: "kybern-visual-link", url: url.href }, "*"); } catch (_) {}
  }, true);
  let height = 0, scheduled = false;
  // The whole document, not just body: a first or last child's margin collapses through body, so
  // body's own box is short by it and the page would scroll inside its frame. The root's auto height
  // contains those margins and, unlike its scrollHeight, is never raised to the frame's height.
  function measure() { scheduled = false; const body = document.body; if (!body) return; const next = Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, body.scrollHeight, body.getBoundingClientRect().height)); if (next > 0 && next !== height) { height = next; window.parent.postMessage({ kind: "kybern-visual-size", height }, "*"); } }
  function schedule() { if (!scheduled) { scheduled = true; nativeRaf(measure); } }
  const observer = new ResizeObserver(schedule);
  document.addEventListener("DOMContentLoaded", () => { observer.observe(document.documentElement); if (document.body) observer.observe(document.body); schedule(); if (window.parent !== window) window.parent.postMessage({ kind: "kybern-visual-ready" }, "*"); });
  window.addEventListener("load", schedule);
})();
