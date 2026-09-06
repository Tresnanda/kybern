// macOS-only regression: use the same system WebKit engine as the Tauri app.
// Run from apps/desktop: swift scripts/check-window-material.swift src/styles/kybern.css
import AppKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

final class MaterialCheck: NSObject, WKNavigationDelegate {
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))

    func run() throws {
        guard CommandLine.arguments.count == 2 else {
            throw NSError(domain: "Pass the path to kybern.css", code: 2)
        }
        let css = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        web.navigationDelegate = self
        web.loadHTMLString("""
        <html data-full-translucency data-window-material="translucent"><head><style>
        .chat-content-card { background: var(--color-background-surface); }
        .app-settings-surface { background: var(--app-settings-surface, var(--color-background-surface)); }
        [data-slot] { background: var(--popover); }
        \(css)
        </style></head><body>
        <main class="chat-content-card">Transcript</main>
        <section class="app-settings-surface">Settings</section>
        <aside data-slot="dialog-popup">Dialog</aside>
        <aside data-slot="alert-dialog-popup">Alert</aside>
        <aside data-slot="popover-popup">Popover</aside>
        <aside data-slot="menu-popup">Menu</aside>
        <aside data-slot="tooltip-popup">Tooltip</aside>
        <aside data-slot="select-popup">Select</aside>
        </body></html>
        """, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        web.evaluateJavaScript("""
        (() => {
          const root = document.documentElement;
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          const results = [];
          const reduced = matchMedia('(prefers-reduced-transparency: reduce)').matches;
          const contrast = matchMedia('(prefers-contrast: more)').matches;
          function alpha(element) {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = getComputedStyle(element).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1).data[3] / 255;
          }
          function verify(name, glass) {
            const active = getComputedStyle(root).getPropertyValue('--app-full-translucency').trim() === '1';
            if (active !== glass) throw new Error(name + ': incorrect glass flag');
            for (const el of document.querySelectorAll('main, section, aside')) {
              const expected = glass ? (el.matches('aside') ? 0.82 : 0.72) : 1;
              const actual = alpha(el);
              if (Math.abs(actual - expected) > 0.01) {
                throw new Error(name + ': ' + el.textContent + ' alpha ' + actual + ', expected ' + expected);
              }
              if (el.matches('aside')) {
                const blur = getComputedStyle(el).getPropertyValue('-webkit-backdrop-filter');
                if ((blur !== 'none' && blur !== '') !== glass) {
                  throw new Error(name + ': ' + el.textContent + ' incorrect backdrop filter ' + blur);
                }
              }
            }
            results.push('PASS: ' + name);
          }
          for (const [theme, surface] of [['dark', 'rgb(30,30,30)'], ['light', 'rgb(245,245,245)']]) {
            root.classList.toggle('dark', theme === 'dark');
            root.setAttribute('data-theme-variant', theme);
            root.style.setProperty('--app-opaque-content-surface', surface);
            root.style.setProperty('--color-background-surface', surface);
            root.style.setProperty('--popover', surface);
            root.setAttribute('data-full-translucency', '');
            root.setAttribute('data-window-material', 'translucent');
            verify(theme + ' enabled (native preferences)', !reduced && !contrast);
            root.removeAttribute('data-full-translucency');
            verify(theme + ' disabled', false);
            root.setAttribute('data-full-translucency', '');
            root.setAttribute('data-window-material', 'opaque');
            verify(theme + ' opaque material', false);
          }
          root.setAttribute('data-window-material', 'translucent');
          // Emulate positive preferences through CSSOM without changing the host's settings.
          // Exercise each branch of the real stylesheet's accessibility media query.
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
