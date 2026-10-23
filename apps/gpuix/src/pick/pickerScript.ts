// The element picker that runs inside the Preview page and inline visuals (`native/webview.m` `frame`: the page's frame, in
// Kybern's isolated content world). The page shares the DOM with it but cannot reach its globals or the `kybernFrame` message
// handler, so a page cannot fake a pick. Everything it reads from the page (text, HTML, selector) is still the page's data.
//
// It installs once per document and does two things:
//  - `⌥-click` on an element posts an `anchor` message (the composer adds a chip), always on, picking or not;
//  - `__kybernPicker.start()` draws the picking overlay (spec `cards/spec.md` §3): the page dims, the hovered element gets a ring and
//    a label, a floating bar says what to do. A click posts `picked`, Esc or "Stop" posts `cancelled`; ⌘-click or ↑ selects the
//    parent, ↓ goes back down, ↵ picks the hovered element.
//
// Messages are `{ kind: 'pick', event, payload? }` through `webkit.messageHandlers.kybernFrame`; each payload is bounded (< 4 KB).
// No source in this string may contain a backtick or `${`: it is a raw template.

export const PICKER_SOURCE = String.raw`(function () {
  var KEY = '__kybernPicker';
  if (window[KEY]) return 'ready';
  var MAX_TEXT = 300, MAX_HTML = 1500, MAX_SELECTOR = 400;
  var post = function (event, payload) {
    try { window.webkit.messageHandlers.kybernFrame.postMessage({ kind: 'pick', event: event, payload: payload || null }); } catch (error) {}
  };
  var esc = function (value) { return (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); };
  var unique = function (selector) { try { return document.querySelectorAll(selector).length === 1; } catch (error) { return false; } };

  function selectorFor(el) {
    var kid = el.getAttribute && el.getAttribute('data-kybern-id');
    if (kid) {
      var byId = '[data-kybern-id="' + kid.replace(/"/g, '\\"') + '"]';
      if (unique(byId)) return byId;
    }
    var parts = [], node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
      var name = node.localName;
      if (node.id && unique('#' + esc(node.id))) { parts.unshift('#' + esc(node.id)); break; }
      var classes = Array.prototype.slice.call(node.classList || []).filter(function (c) { return c.length < 30 && !/^[0-9]/.test(c); }).slice(0, 2);
      name += classes.map(function (c) { return '.' + esc(c); }).join('');
      var siblings = node.parentElement ? Array.prototype.filter.call(node.parentElement.children, function (n) { return n.localName === node.localName; }) : [];
      if (siblings.length > 1) name += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(name);
      var candidate = parts.join(' > ');
      if (unique(candidate)) return candidate.slice(0, MAX_SELECTOR);
      node = node.parentElement;
    }
    return (parts.join(' > ') || el.localName).slice(0, MAX_SELECTOR);
  }

  function describe(el) {
    var rect = el.getBoundingClientRect();
    var text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    var owner = el.closest ? el.closest('[data-kybern-id]') : null;
    var out = {
      selector: selectorFor(el), tag: el.localName, text: text,
      html: String(el.outerHTML || '').slice(0, MAX_HTML),
      page_url: String(location.href).split('#')[0].slice(0, 500),
      box: { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10, width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 }
    };
    if (owner) out.id = String(owner.getAttribute('data-kybern-id')).slice(0, 200);
    return out;
  }

  // ⌥-click: the person points at something while writing. Capture phase, so the page never sees the click.
  var anchorTarget = null;
  function inOverlay(event) { return overlay && event.target === overlay.host; }
  function onAnchorDown(event) { if (!picking && event.altKey && event.button === 0) { event.preventDefault(); event.stopImmediatePropagation(); anchorTarget = event.target; } }
  function onAnchorClick(event) {
    if (picking || !event.altKey || event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    var el = event.target;
    if (el && el.nodeType === 1) post('anchor', describe(el));
  }
  document.addEventListener('mousedown', onAnchorDown, true);
  document.addEventListener('click', onAnchorClick, true);

  // The picking overlay.
  var picking = false, overlay = null, hovered = null, depth = 0, lastTarget = null;
  var CSSTEXT = '.dim{position:fixed;inset:0;background:rgba(20,20,20,.18);opacity:0;transition:opacity 150ms cubic-bezier(.23,1,.32,1)}' +
    '.dim.on{opacity:1}' +
    '.ring{position:fixed;display:none;box-sizing:border-box;border:2px solid #3386d6;border-radius:6px;background:rgba(51,134,214,.10);box-shadow:0 0 0 5px rgba(51,134,214,.22)}' +
    '.tag{position:fixed;display:none;box-sizing:border-box;height:22px;padding:0 8px;border-radius:6px;background:#1f5f9e;color:#fff;font:600 11.5px/22px -apple-system,system-ui,sans-serif;white-space:nowrap;max-width:calc(100vw - 16px);overflow:hidden;text-overflow:ellipsis}' +
    '.tag code{font:500 10.5px/22px Menlo,ui-monospace,monospace;opacity:.85;margin-left:6px}' +
    '.bar{position:fixed;top:14px;left:50%;transform:translate(-50%,-4px);display:flex;align-items:center;gap:10px;height:34px;padding:0 6px 0 14px;border-radius:999px;background:rgba(28,28,28,.82);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);color:#fff;font:500 12.5px/1 -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28);pointer-events:auto;opacity:0;transition:opacity 150ms cubic-bezier(.23,1,.32,1),transform 150ms cubic-bezier(.23,1,.32,1);white-space:nowrap}' +
    '.bar.on{opacity:1;transform:translate(-50%,0)}' +
    '.stop{display:flex;align-items:center;gap:6px;height:24px;padding:0 6px 0 10px;border:0;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;font:inherit;cursor:pointer}' +
    '.stop:hover{background:rgba(255,255,255,.2)}' +
    '.stop kbd{font:600 10.5px/16px -apple-system,system-ui,sans-serif;padding:0 5px;border-radius:5px;background:rgba(255,255,255,.14)}' +
    '@media (prefers-reduced-motion: reduce){.dim,.bar{transition:opacity 150ms linear}.bar{transform:translate(-50%,0)}}';

  function build(text) {
    var host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    var root = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style'); style.textContent = CSSTEXT; root.appendChild(style);
    var dim = document.createElement('div'); dim.className = 'dim'; root.appendChild(dim);
    var ring = document.createElement('div'); ring.className = 'ring'; root.appendChild(ring);
    var tag = document.createElement('div'); tag.className = 'tag'; root.appendChild(tag);
    var bar = document.createElement('div'); bar.className = 'bar';
    var label = document.createElement('span'); label.textContent = text || 'Click the element you mean'; bar.appendChild(label);
    var stop = document.createElement('button'); stop.className = 'stop'; stop.type = 'button';
    stop.appendChild(document.createTextNode('Stop'));
    var kbd = document.createElement('kbd'); kbd.textContent = 'esc'; stop.appendChild(kbd);
    stop.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); finish('cancelled'); });
    bar.appendChild(stop); root.appendChild(bar);
    document.documentElement.appendChild(host);
    requestAnimationFrame(function () { dim.className = 'dim on'; bar.className = 'bar on'; });
    return { host: host, ring: ring, tag: tag };
  }

  function ancestor(el, up) { var node = el; for (var i = 0; i < up && node && node.parentElement && node.parentElement !== document.documentElement; i++) node = node.parentElement; return node; }
  function current() { return lastTarget ? ancestor(lastTarget, depth) : null; }
  function paint() {
    var el = current();
    if (!overlay || !el || el === document.documentElement) { if (overlay) { overlay.ring.style.display = 'none'; overlay.tag.style.display = 'none'; } return; }
    hovered = el;
    var rect = el.getBoundingClientRect();
    var ring = overlay.ring.style;
    ring.display = 'block'; ring.left = rect.left + 'px'; ring.top = rect.top + 'px'; ring.width = rect.width + 'px'; ring.height = rect.height + 'px';
    var tag = overlay.tag;
    var short = el.localName + (el.id ? '#' + el.id : '') + (el.classList && el.classList.length ? '.' + el.classList[0] : '');
    tag.textContent = '';
    var strong = document.createElement('span'); strong.textContent = el.localName; tag.appendChild(strong);
    var meta = document.createElement('code'); meta.textContent = short.slice(el.localName.length) + (short.length > el.localName.length ? ' · ' : '') + Math.round(rect.width) + ' × ' + Math.round(rect.height); tag.appendChild(meta);
    tag.style.display = 'block';
    var below = rect.bottom + 8 + 22 <= window.innerHeight;
    tag.style.top = (below ? rect.bottom + 8 : Math.max(4, rect.top - 30)) + 'px';
    tag.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 220)) + 'px';
  }

  function onMove(event) {
    if (inOverlay(event)) return;
    var el = event.target;
    if (!el || el.nodeType !== 1) return;
    if (el !== lastTarget) depth = 0;
    lastTarget = el;
    if (event.metaKey) depth = Math.max(depth, 1);
    paint();
  }
  function swallow(event) { if (inOverlay(event)) return; event.preventDefault(); event.stopImmediatePropagation(); }
  function onClick(event) {
    if (inOverlay(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.target && event.target.nodeType === 1 && event.target !== lastTarget) { lastTarget = event.target; depth = event.metaKey ? 1 : 0; }
    var el = current() || event.target;
    if (el && el.nodeType === 1) finish('picked', describe(el));
  }
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish('cancelled'); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); event.stopImmediatePropagation(); depth += 1; paint(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); event.stopImmediatePropagation(); depth = Math.max(0, depth - 1); paint(); return; }
    if (event.key === 'Enter' && current()) { event.preventDefault(); event.stopImmediatePropagation(); finish('picked', describe(current())); return; }
    event.stopImmediatePropagation();
  }
  var EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick', 'touchstart', 'touchend'];
  function listen(on) {
    var method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('mousemove', onMove, true);
    document[method]('click', onClick, true);
    document[method]('keydown', onKey, true);
    document[method]('keyup', swallow, true);
    window[method]('scroll', paint, true);
    window[method]('resize', paint, true);
    for (var i = 0; i < EVENTS.length; i++) document[method](EVENTS[i], swallow, true);
  }
  function teardown() {
    if (!picking) return;
    picking = false; listen(false);
    if (overlay) { overlay.host.remove(); overlay = null; }
    hovered = null; lastTarget = null; depth = 0;
  }
  function finish(event, payload) { teardown(); post(event, payload); }

  window[KEY] = {
    start: function (text) {
      if (picking) return 'picking';
      picking = true; depth = 0; lastTarget = null; overlay = build(typeof text === 'string' ? text : ''); listen(true);
      try { window.focus(); } catch (error) {}
      return 'picking';
    },
    stop: function () { teardown(); return 'stopped'; }
  };
  return 'ready';
})()`
