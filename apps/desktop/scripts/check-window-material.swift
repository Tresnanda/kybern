// macOS-only regression: the real production CSS and runtime theme tokens in WKWebView.
// Run after pnpm build: node --experimental-strip-types scripts/check-window-material.mjs
import AppKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

final class MaterialCheck: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
    var themes = "{}"
    var window: NSWindow!

    func run() throws {
        guard CommandLine.arguments.count == 3 else {
            throw NSError(domain: "Pass the paths to production CSS and theme JSON", code: 2)
        }
        let css = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        themes = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
        // Exercise the same mounted state as the app, including frame delivery.
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Kybern material checks"
        window.contentView = web
        window.orderFront(nil)
        web.configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "materialPixels")
        web.navigationDelegate = self
        web.loadHTMLString("""
        <!doctype html><html data-runtime="electron" data-platform="macos"><head><style>
        .chat-content-card { background: var(--color-background-surface); }
        .app-settings-surface { background: var(--app-settings-surface, var(--color-background-surface)); }
        aside { background: var(--popover); }
        \(css)
        </style></head><body>
        <main class="chat-content-card">Transcript</main>
        <section class="app-settings-surface">Settings</section>
        <article class="chat-composer-surface">Composer</article>
        <article class="chat-composer-stacked-top">Stacked panel</article>
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
        <div style="position:fixed;left:16px;top:480px;width:528px;height:64px;z-index:10000">
          <div style="position:absolute;inset:0 auto 0 0;width:256px;background:repeating-linear-gradient(90deg,black 0 2px,white 2px 4px)">
            <div class="chat-composer-surface" style="position:absolute;inset:0;z-index:1;background:transparent!important;border-radius:0"></div>
          </div>
          <div style="position:absolute;inset:0 0 0 auto;width:256px;background:repeating-linear-gradient(90deg,black 0 2px,white 2px 4px)">
            <div class="chat-composer-stacked-top" style="position:absolute;inset:0;z-index:1;background:transparent!important;border-radius:0"></div>
          </div>
        </div>
        </body></html>
        """, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        web.callAsyncJavaScript("""
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
          const filter = (el, pseudo) => {
            const style = getComputedStyle(el, pseudo);
            return style.getPropertyValue('backdrop-filter') || style.getPropertyValue('-webkit-backdrop-filter') || 'none';
          };
          // Let style changes reach layout and generated layers before inspecting
          // them. Reading every mode in one script can observe stale pseudo styles.
          const settle = () => new Promise(resolve => requestAnimationFrame(() => {
            root.getBoundingClientRect();
            requestAnimationFrame(resolve);
          }));
          function alpha(element) {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = background(element);
            context.fillRect(0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1).data[3] / 255;
          }
          async function verifyComposer(name, glass) {
            for (const el of elements.filter(el => el.matches('article'))) {
              if (!glass && alpha(el) < 0.99) throw new Error(name + ': ' + el.textContent + ' must be opaque, alpha ' + alpha(el));
              if (filter(el) !== 'none') throw new Error(name + ': duplicate composer blur');
            }
            // Older WebKit reports `none` for backdrop-filter on pseudo-elements,
            // even for a literal blur declaration. Verify rendered stripes instead.
            // Only these dedicated probes have transparent fills, so opaque paint
            // cannot hide a blur layer that should have been disabled.
            const contrasts = await window.webkit.messageHandlers.materialPixels.postMessage({});
            for (const [index, contrast] of contrasts.entries()) {
              if (glass ? contrast > 0.15 : contrast < 0.8) throw new Error(name + ': composer ' + index + ' stripe contrast ' + contrast + ', expected ' + (glass ? 'blurred' : 'sharp'));
            }
            results.push('PASS: ' + name + ' composer and stacked panels');
          }
          async function verify(name, glass) {
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
            await verifyComposer(name, glass);
            results.push('PASS: ' + name);
          }
          for (const [theme, variables] of Object.entries(themes)) {
            root.classList.toggle('dark', theme === 'dark');
            root.setAttribute('data-theme-variant', theme);
            for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
            root.removeAttribute('data-full-translucency');
            root.setAttribute('data-window-material', 'translucent');
            await settle();
            const original = elements.map(background);
            root.setAttribute('data-full-translucency', '');
            await settle();
            await verify(theme + ' enabled (native preferences)', !reduced && !contrast);
            root.removeAttribute('data-full-translucency');
            await settle();
            if (JSON.stringify(elements.map(background)) !== JSON.stringify(original)) throw new Error(theme + ': disabling glass must restore original surfaces');
            results.push('PASS: ' + theme + ' disabled restores original surfaces');
            root.setAttribute('data-full-translucency', '');
            root.setAttribute('data-window-material', 'opaque');
            await settle();
            await verifyComposer(theme + ' opaque material', false);
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
            await settle();
            await verify(preference + ' (emulated)', false);
            rules.forEach((rule, i) => rule.media.mediaText = saved[i]);
          }
          await settle();
          await verify('restored native preferences', !reduced && !contrast);
          return results.join('\\n');
        """, arguments: [:], in: nil, in: .page) { outcome in
            switch outcome {
            case .failure(let error):
                let detail = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String
                print("FAIL: \(detail ?? error.localizedDescription)")
                exit(1)
            case .success(let result):
                print(result as? String ?? "No result")
                exit(result is String ? 0 : 1)
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        // WKWebView.takeSnapshot omits composited backdrop filters. Capture only
        // this fixture window so the assertion sees the actual displayed material.
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("kybern-material-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: file) }
        let capture = Process()
        capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-o", "-l", String(window.windowNumber), file.path]
        do {
            try capture.run()
            capture.waitUntilExit()
            guard capture.terminationStatus == 0, let image = NSImage(contentsOf: file), let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else {
                replyHandler(nil, "No material window capture")
                return
            }
            let scaleX = Double(bitmap.pixelsWide) / window.frame.width
            let scaleY = Double(bitmap.pixelsHigh) / window.frame.height
            let titleHeight = window.frame.height - web.frame.height
            func luminance(_ x: Int, _ y: Int) -> Double {
                guard let color = bitmap.colorAt(x: Int(Double(x + 16) * scaleX), y: Int((Double(y + 480) + titleHeight) * scaleY))?.usingColorSpace(.deviceRGB) else { return .nan }
                return (color.redComponent + color.greenComponent + color.blueComponent) / 3
            }
            let contrasts = [0, 272].map { offset -> Double in
                var total = 0.0
                var count = 0.0
                for y in stride(from: 16, to: 48, by: 4) {
                    for x in stride(from: 33, to: 225, by: 4) {
                        total += abs(luminance(offset + x, y) - luminance(offset + x + 2, y))
                        count += 1
                    }
                }
                return total / count
            }
            guard contrasts.allSatisfy({ $0.isFinite }) else {
                replyHandler(nil, "Unreadable material snapshot pixels")
                return
            }
            replyHandler(contrasts, nil)
        } catch {
            replyHandler(nil, error.localizedDescription)
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
DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    print("FAIL: WebKit check timed out")
    exit(2)
}
app.run()
