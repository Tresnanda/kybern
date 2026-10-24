// Mermaid diagrams in answers (P2-5): the desktop's renderer settings (strict security, no HTML
// labels, 32 KiB cap) in a sandboxed WebView with no access to the app or the daemon. The script
// is Mermaid 12.0.0 from jsDelivr, the version the desktop bundles; offline or on a parse error
// the source shows as a code block instead.
import { memo, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { T, Tap } from "./primitives";
import { radius, space, useTheme } from "./theme";

const SOURCE_LIMIT = 32_768;
const SCRIPT = "https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.min.js";

function page(source: string, dark: boolean, ink: string) {
  // The source goes in as JSON, never as markup.
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:transparent;color:${ink}}#d{display:flex;justify-content:center}svg{max-width:100%;height:auto}</style>
<script src="${SCRIPT}"></script></head><body><div id="d"></div><script>
(function(){var post=function(m){window.ReactNativeWebView.postMessage(JSON.stringify(m))};
if(!window.mermaid){post({error:"offline"});return}
try{mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:${dark ? '"dark"' : '"default"'},flowchart:{htmlLabels:false},fontFamily:"-apple-system,system-ui,Roboto,sans-serif"});
mermaid.render("k",${JSON.stringify(source)}).then(function(r){var d=document.getElementById("d");d.innerHTML=r.svg;
requestAnimationFrame(function(){post({height:Math.ceil(d.getBoundingClientRect().height)})})}).catch(function(e){post({error:String(e&&e.message||e)})})}
catch(e){post({error:String(e&&e.message||e)})}})();</script></body></html>`;
}

/** `code` is the source as a code block (Markdown's `Code`), shown offline, on errors and on request. */
export const MermaidBlock = memo(function MermaidBlock({ source, code: sourceBlock }: { source: string; code: ReactNode }) {
  const { colors, dark } = useTheme();
  const [height, setHeight] = useState(0);
  const [failed, setFailed] = useState(source.length > SOURCE_LIMIT);
  const [code, setCode] = useState(false);
  const html = useMemo(() => page(source, dark, colors.ink), [source, dark, colors.ink]);
  if (failed || code)
    return (
      <View>
        {sourceBlock}
        {!failed && (
          <Tap label="Show diagram" onPress={() => setCode(false)} style={{ alignSelf: "flex-start", minHeight: 36, justifyContent: "center" }}>
            <T variant="footnote" tone="accent">
              Show diagram
            </T>
          </Tap>
        )}
      </View>
    );
  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data) as { height?: number; error?: string };
      if (data.error) setFailed(true);
      else if (data.height) setHeight(Math.min(1600, Math.max(40, data.height)));
    } catch {
      setFailed(true);
    }
  };
  return (
    <View style={{ gap: space.xs }}>
      <View style={{ borderRadius: radius.md, borderCurve: "continuous", backgroundColor: colors.code, padding: space.md, overflow: "hidden" }}>
        <WebView
          source={{ html }}
          originWhitelist={["about:blank", "https://cdn.jsdelivr.net"]}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={(request) => request.url === "about:blank" || request.url.startsWith("https://cdn.jsdelivr.net/")}
          scrollEnabled={false}
          incognito
          javaScriptEnabled
          setSupportMultipleWindows={false}
          allowsLinkPreview={false}
          accessibilityLabel="Diagram"
          style={{ height: height || 120, backgroundColor: "transparent", opacity: height ? 1 : 0 }}
          containerStyle={{ backgroundColor: "transparent" }}
        />
      </View>
      <Tap label="Show diagram source" onPress={() => setCode(true)} style={{ alignSelf: "flex-start", minHeight: 36, justifyContent: "center" }}>
        <T variant="footnote" tone="accent">
          Show source
        </T>
      </Tap>
    </View>
  );
});
