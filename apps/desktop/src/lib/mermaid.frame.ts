// Mermaid measures SVG text using the DOM. Bundle this as a separate entry and
// run it in a disposable document, so its module graph can be released at idle.
import mermaid from "mermaid"
import type { HighlightJob } from "./highlightQueue"

window.addEventListener("message", (event: MessageEvent<HighlightJob>) => {
  if (event.source !== parent || !event.data || typeof event.data.code !== "string") return
  const job = event.data
  void (async () => {
    let html: string | null = null
    try {
      mermaid.initialize({
        startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
        theme: job.dark ? "dark" : "default", fontFamily: "system-ui, sans-serif",
        htmlLabels: false, maxTextSize: 32_768, maxEdges: 256,
        // Diagram directives must not loosen our limits or enable HTML labels.
        secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "htmlLabels", "suppressErrorRendering"],
      })
      if (await mermaid.parse(job.code, { suppressErrors: true })) {
        const result = await mermaid.render(`diagram-${job.id}`, job.code)
        if (result.svg.length <= 512 * 1024) html = result.svg
      }
    } catch { /* Invalid/incomplete diagrams stay readable as source. */ }
    document.body.replaceChildren()
    parent.postMessage({ mermaid: true, id: job.id, html }, "*")
  })()
})
parent.postMessage({ mermaid: true, ready: true }, "*")
