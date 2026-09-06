// macOS-only regression: the real production CSS and runtime theme tokens in WKWebView.
// Run after pnpm build: node --experimental-strip-types scripts/check-window-material.mjs
import AppKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

final class MaterialCheck: NSObject, WKNavigationDelegate {
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
    var themes = "{}"

    func run() throws {
        guard CommandLine.arguments.count == 3 else {
            throw NSError(domain: "Pass the paths to production CSS and theme JSON", code: 2)
        }
        let css = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        themes = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
        web.navigationDelegate = self
        web.loadHTMLString("""
        <html data-runtime="electron" data-platform="macos"><head><style>
        .chat-content-card { background: var(--color-background-surface); }
        .app-settings-surface { background: var(--app-settings-surface, var(--color-background-surface)); }
        aside { background: var(--popover); }
        \(css)
        </style></head><body>
        <main class="chat-content-card">Transcript</main>
        <section class="app-settings-surface">Settings</section>
        <article class="chat-composer-surface">Composer</article>
        <div data-probe style="background:var(--app-user-message-background)">Message bubble</div>
        <div data-probe style="background:var(--card)">Card</div>
        <div data-probe style="background:var(--app-chat-code-surface)">Code block</div>
        <div data-probe style="background:var(--color-background-control-opaque)">Control</div>
        <aside data-slot="dialog-popup">Dialog</aside>
        <aside data-slot="alert-dialog-popup">Alert</aside>
        <aside data-slot="popover-popup">Popover</aside>
        <aside data-slot="menu-popup">Menu</aside>
        <aside data-slot="menu-sub-content">Submenu</aside>
        <aside data-slot="context-menu-content">Context menu</aside>
        <aside data-slot="context-menu-sub-content">Context submenu</aside>
        <aside data-slot="tooltip-popup">Tooltip</aside>
        <aside data-slot="select-popup">Select</aside>
        <aside data-slot="combobox-popup">Combobox</aside>
        <aside data-slot="preview-card-popup">Preview card</aside>
        <aside data-slot="sheet-popup">Sheet</aside>
        </body></html>
        """, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        web.evaluateJavaScript("""
        (() => {
          const themes = \(themes);
          const root = document.documentElement;
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          const elements = Array.from(document.querySelectorAll('main, section, article, aside, [data-probe]'));
          const results = [];
          const reduced = matchMedia('(prefers-reduced-transparency: reduce)').matches;
          const contrast = matchMedia('(prefers-contrast: more)').matches;
          const background = el => getComputedStyle(el).backgroundColor;
          const filter = (el, pseudo) => getComputedStyle(el, pseudo).getPropertyValue('-webkit-backdrop-filter');
          function alpha(element) {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = background(element);
            context.fillRect(0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1).data[3] / 255;
          }
          function verify(name, glass) {
            const active = getComputedStyle(root).getPropertyValue('--app-full-translucency').trim() === '1';
            if (active !== glass) throw new Error(name + ': incorrect glass flag');
            for (const el of elements) {
              const actual = alpha(el);
              if (glass ? !(actual > 0 && actual < 0.95) : actual < 0.99) {
                throw new Error(name + ': ' + el.textContent + ' alpha ' + actual + ', expected ' + (glass ? 'translucent' : 'opaque'));
              }
              if (el.matches('aside')) {
                const blur = filter(el);
                if ((blur !== 'none' && blur !== '') !== glass) {
                  throw new Error(name + ': ' + el.textContent + ' incorrect backdrop filter ' + blur);
                }
                const before = filter(el, '::before');
                if (before !== 'none' && before !== '') throw new Error(name + ': duplicate popup blur');
              }
              if (getComputedStyle(el).opacity !== '1') throw new Error(name + ': text opacity must remain unchanged');
            }
            results.push('PASS: ' + name);
          }
          for (const [theme, variables] of Object.entries(themes)) {
            root.classList.toggle('dark', theme === 'dark');
            root.setAttribute('data-theme-variant', theme);
            for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
            root.removeAttribute('data-full-translucency');
            root.setAttribute('data-window-material', 'translucent');
            const original = elements.map(background);
            root.setAttribute('data-full-translucency', '');
            verify(theme + ' enabled (native preferences)', !reduced && !contrast);
            root.removeAttribute('data-full-translucency');
            if (JSON.stringify(elements.map(background)) !== JSON.stringify(original)) throw new Error(theme + ': disabling glass must restore original surfaces');
            results.push('PASS: ' + theme + ' disabled restores original surfaces');
            root.setAttribute('data-full-translucency', '');
            root.setAttribute('data-window-material', 'opaque');
            if (JSON.stringify(elements.map(background)) !== JSON.stringify(original)) throw new Error(theme + ': opaque material must keep original surfaces');
            results.push('PASS: ' + theme + ' opaque material');
          }
          root.setAttribute('data-window-material', 'translucent');
          // Emulate positive preferences through CSSOM without changing host settings.
          for (const preference of ['prefers-reduced-transparency: reduce', 'prefers-contrast: more']) {
            const rules = Array.from(document.styleSheets[0].cssRules).filter(rule =>
              rule instanceof CSSMediaRule && rule.conditionText.split(' ').join('').includes(preference.split(' ').join('')));
            if (!rules.length) throw new Error('Missing accessibility override: ' + preference);
            const saved = rules.map(rule => rule.media.mediaText);
            rules.forEach(rule => rule.media.mediaText = 'all');
            verify(preference + ' (emulated)', false);
            rules.forEach((rule, i) => rule.media.mediaText = saved[i]);
          }
          verify('restored native preferences', !reduced && !contrast);
          return results.join('\\n');
        })()
        """) { result, error in
            if let error {
                let detail = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String
                print("FAIL: \(detail ?? error.localizedDescription)")
                exit(1)
            }
            print(result as? String ?? "No result")
            exit(result is String ? 0 : 1)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("FAIL: \(error.localizedDescription)")
        exit(1)
    }
}

let check = MaterialCheck()
do { try check.run() } catch {
    print("FAIL: \(error.localizedDescription)")
    exit(2)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
    print("FAIL: WebKit check timed out")
    exit(2)
}
app.run()
