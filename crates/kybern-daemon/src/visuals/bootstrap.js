(function () {
  const style = document.getElementById("kybern-visual-theme");
  // The frame fits the page, so the page never scrolls itself (`overflow:hidden` on the root): the wheel scrolls the chat,
  // and only the page's own scroll areas take it (`scrollers` below).
  const base = "html{background:transparent;color:var(--foreground);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;scrollbar-width:none;overflow:hidden}html::-webkit-scrollbar{display:none}body{margin:0}code,pre,kbd{font-family:var(--font-mono)}";
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
  // A press on the picture, replayed where it landed once the live page is ready: the whole press (pointer and mouse down
  // and up, then click) on the element under it, so canvases and custom controls get it too, not only buttons.
  function replay(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el === document.documentElement) return;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, view: window };
    const fire = (Kind, type, buttons, extra) => { try { return el.dispatchEvent(new Kind(type, Object.assign({}, init, { buttons }, extra))); } catch (_) { return true; } };
    const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: 0.5 };
    if (window.PointerEvent) fire(window.PointerEvent, "pointerdown", 1, pointer);
    if (fire(window.MouseEvent, "mousedown", 1, { detail: 1 })) {
      const focusable = el.closest && el.closest("input,textarea,select,button,a[href],[tabindex],[contenteditable],[contenteditable=true]");
      if (focusable && focusable.focus) focusable.focus({ preventScroll: true });
    }
    if (window.PointerEvent) fire(window.PointerEvent, "pointerup", 0, Object.assign({}, pointer, { pressure: 0 }));
    fire(window.MouseEvent, "mouseup", 0, { detail: 1 });
    fire(window.MouseEvent, "click", 0, { detail: 1 });
  }
  // Focus never scrolls: a label's control, a script's focus() and autofocus stay where they are (the frame fits the page).
  const HTMLElementType = window.HTMLElement;
  if (HTMLElementType && HTMLElementType.prototype.focus) {
    const nativeFocus = HTMLElementType.prototype.focus;
    HTMLElementType.prototype.focus = function (options) { return nativeFocus.call(this, Object.assign({ preventScroll: true }, options && typeof options === "object" ? options : {})); };
  }
  document.addEventListener("click", e => {
    const label = e.target && e.target.closest && e.target.closest("label");
    const control = label && label.control;
    if (!control || control === e.target || (control.contains && control.contains(e.target))) return;
    // The browser's own activation still toggles the control; focus it first without scrolling.
    if (control.focus) control.focus({ preventScroll: true });
  }, true);
  // The page's own scroll areas, for the native host (`webview.m`, `webview-win`, `webview-linux.c`): over one that can
  // still scroll the way a wheel gesture starts, the page takes the gesture; anywhere else the chat scrolls. Each entry
  // is [x, y, width, height, room] in the frame's CSS pixels, room = 1 up, 2 down, 4 left, 8 right. Elements with a
  // non-passive wheel listener (zoomable charts, maps) take every direction.
  const wheelTakers = new Set();
  const Target = window.EventTarget && window.EventTarget.prototype;
  if (Target && Target.addEventListener) {
    const nativeAdd = Target.addEventListener;
    Target.addEventListener = function (type, listener, options) {
      if ((type === "wheel" || type === "mousewheel") && !(options && typeof options === "object" && options.passive === true) && window.Element && this instanceof window.Element && this !== document.documentElement && this !== document.body) { wheelTakers.add(this); scheduleScan(); }
      return nativeAdd.call(this, type, listener, options);
    };
  }
  const MAX_SCROLLERS = 64;
  let scrollerElements = [], lastScrollers = "", scanTimer = 0, roomQueued = false;
  function room(el) {
    if (wheelTakers.has(el)) return 15;
    const style = getComputedStyle(el), y = style.overflowY, x = style.overflowX;
    let bits = 0;
    if ((y === "auto" || y === "scroll" || el.tagName === "TEXTAREA") && el.scrollHeight > el.clientHeight + 1) {
      if (el.scrollTop > 0.5) bits |= 1;
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 1) bits |= 2;
    }
    if ((x === "auto" || x === "scroll") && el.scrollWidth > el.clientWidth + 1) {
      const left = Math.abs(el.scrollLeft);
      if (left > 0.5) bits |= 4;
      if (left + el.clientWidth < el.scrollWidth - 1) bits |= 8;
    }
    return bits;
  }
  function report() {
    roomQueued = false;
    const rects = [];
    for (const el of scrollerElements) {
      if (!el.isConnected) continue;
      const bits = room(el);
      if (!bits) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      rects.push([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), bits]);
    }
    const key = JSON.stringify(rects);
    if (key === lastScrollers) return;
    lastScrollers = key;
    post({ kind: "kybern-visual-scrollers", rects });
  }
  // Every element that can scroll at all (whatever its position now); `report` reads their room and boxes.
  function scan() {
    scanTimer = 0;
    if (!document.body || !document.querySelectorAll) return;
    const found = [];
    for (const el of wheelTakers) if (el.isConnected && found.length < MAX_SCROLLERS) found.push(el);
    for (const el of document.body.querySelectorAll("*")) {
      if (found.length >= MAX_SCROLLERS) break;
      if (wheelTakers.has(el) || (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)) continue;
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY + style.overflowX) || el.tagName === "TEXTAREA") found.push(el);
    }
    scrollerElements = found;
    report();
  }
  function scheduleScan() { if (!scanTimer && window.setTimeout) scanTimer = window.setTimeout(scan, 120); }
  // A scroll inside an area changes only its room: no rescan.
  document.addEventListener("scroll", () => { if (!roomQueued) { roomQueued = true; nativeRaf(report); } }, true);
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
  function measure() { scheduled = false; const body = document.body; if (!body) return; const next = Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, body.scrollHeight, body.getBoundingClientRect().height)); if (next > 0 && next !== height) { height = next; window.parent.postMessage({ kind: "kybern-visual-size", height }, "*"); } if (window.parent !== window) scheduleScan(); }
  function schedule() { if (!scheduled) { scheduled = true; nativeRaf(measure); } }
  const observer = new ResizeObserver(schedule);
  document.addEventListener("DOMContentLoaded", () => {
    observer.observe(document.documentElement); if (document.body) observer.observe(document.body); schedule();
    if (window.parent !== window) {
      window.parent.postMessage({ kind: "kybern-visual-ready" }, "*");
      // Areas appear and change size without changing the page's height (tabs, filters, lists filling in).
      if (window.MutationObserver && document.body) new window.MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
    }
  });
  window.addEventListener("load", schedule);
})();
