import path from "node:path"
import { readFileSync } from "node:fs"
import { mergeConfig } from "vite"
import base from "../vite.config"
export default mergeConfig(base, {
  define: {
    __TOOL_LEASE_ENDPOINT__: process.env.KYBERN_TOOL_LEASE_ENDPOINT ?? "null",
    __TERMINAL_RETAIN__: JSON.stringify(process.env.KYBERN_TERMINAL_RETAIN === "1"),
    __INTEGRATION_PREVIEW_URLS__: process.env.KYBERN_INTEGRATION_PREVIEW_URLS ?? "[]",
    __WORK_REPLAY__: process.env.KYBERN_WORK_REPLAY ? readFileSync(process.env.KYBERN_WORK_REPLAY, "utf8") : "[]",
    __SCROLL_SCENARIO__: JSON.stringify(process.env.KYBERN_SCROLL_SCENARIO ?? ""),
    __SCROLL_FRAMES__: JSON.stringify(Number(process.env.KYBERN_SCROLL_FRAMES ?? 100)),
    __SCROLL_COMPOSER__: JSON.stringify(process.env.KYBERN_SCROLL_COMPOSER === "1"),
    __SCROLL_COMPOSER_GLASS__: JSON.stringify(process.env.KYBERN_SCROLL_COMPOSER_GLASS === "1"),
    __SCROLL_MEMORY__: JSON.stringify(process.env.KYBERN_SCROLL_MEMORY === "1"),
    __SCROLL_PROBE__: JSON.stringify(process.env.KYBERN_SCROLL_PROBE === "1"),
    __SCROLL_EXTRA_CSS__: JSON.stringify(process.env.KYBERN_SCROLL_EXTRA_CSS ?? ""),
    __SCROLL_IDLE_MS__: JSON.stringify(Math.max(0, Math.min(30000, Number(process.env.KYBERN_SCROLL_IDLE_MS) || 0))),
    __COMPOSER_STACK_MODE__: JSON.stringify(process.env.KYBERN_COMPOSER_STACK_MODE ?? "queue"),
    __COLLAB_THEME__: JSON.stringify(process.env.KYBERN_COLLAB_THEME ?? "dark"),
    __COLLAB_REPLAY__: process.env.KYBERN_COLLAB_REPLAY ? readFileSync(process.env.KYBERN_COLLAB_REPLAY, "utf8") : "null",
    __COLLAB_VIEW__: JSON.stringify(process.env.KYBERN_COLLAB_VIEW ?? "work"),
    __COLLAB_STRESS__: JSON.stringify(process.env.KYBERN_COLLAB_STRESS ?? ""),
    __UPDATE_VIEW__: JSON.stringify(process.env.KYBERN_UPDATE_VIEW ?? "card"),
    __UPDATE_THEME__: JSON.stringify(process.env.KYBERN_UPDATE_THEME ?? "dark"),
    __UPDATE_REDUCED_MOTION__: JSON.stringify(process.env.KYBERN_UPDATE_REDUCED_MOTION === "1"),
  },
  plugins: process.env.KYBERN_PERF_FIXTURE === "chat-fixes" ? [{
    name: "draft-asset-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/ComposerImageAttachment.tsx")) return
      return code.replace('"@/state/rpc"', JSON.stringify(path.resolve(import.meta.dirname, "chat-fixes-assets.ts")))
    },
  }] : process.env.KYBERN_PERF_FIXTURE === "usage" ? [{
    name: "usage-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/views/UsagePage.tsx")) return
      return code.replaceAll('"@/state/rpc"', JSON.stringify(path.resolve(import.meta.dirname, "usage-rpc.ts")))
    },
  }] : process.env.KYBERN_PERF_FIXTURE === "settings" ? [{
    name: "settings-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/src/") || id.includes("/src/state/")) return
      return code.replaceAll('"@/state/rpc"', JSON.stringify(path.resolve(import.meta.dirname, "settings-rpc.ts")))
    },
  }] : process.env.KYBERN_PERF_FIXTURE === "app-update" ? [{
    name: "app-update-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!/\/(AppUpdate|Sidebar)\.tsx$/.test(id)) return
      return code.replaceAll('"@/lib/appUpdate"', JSON.stringify(path.resolve(import.meta.dirname, "app-update-transport.ts")))
    },
  }] : ["chat-collaboration", "composer-stack"].includes(process.env.KYBERN_PERF_FIXTURE ?? "") ? [{
    name: "chat-collaboration-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/src/") || id.includes("/src/state/")) return
      return code.replaceAll('"@/state/rpc"', JSON.stringify(path.resolve(import.meta.dirname, "chat-collaboration-rpc.ts")))
    },
  }] : process.env.KYBERN_PERF_FIXTURE === "collaboration" ? [{
    name: "collaboration-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!/\/Collaboration\.tsx$/.test(id)) return
      const source = process.env.KYBERN_COLLAB_BASELINE ? readFileSync(process.env.KYBERN_COLLAB_BASELINE, "utf8") : code
      return source.replace('"@/state/rpc"', JSON.stringify(path.resolve(import.meta.dirname, "collaboration-rpc.ts")))
    },
  }] : ["history", "history-retention"].includes(process.env.KYBERN_PERF_FIXTURE ?? "") ? [{
    name: "history-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!/\/(useEarlierHistory\.ts|Transcript\.tsx)$/.test(id)) return
      return code.replace('"@/state/rpc"', JSON.stringify(path.resolve(import.meta.dirname, "history-rpc.ts")))
    },
  }] : process.env.KYBERN_PERF_FIXTURE === "integrations" ? [{
    name: "integrations-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!/\/(Integrations|Artifacts|Terminal)\.tsx$/.test(id)) return
      return code.replace(/"@\/state\/rpc"|"@\/lib\/tauri"/g, JSON.stringify(path.resolve(import.meta.dirname, "integrations-rpc.ts")))
    },
  }] : process.env.KYBERN_PERF_FIXTURE === "questions" ? [{
    name: "question-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!/\/(AsyncQuestionPanel|UserInputPanel)\.tsx$/.test(id)) return
      return code.replace('"@/state/rpc"', JSON.stringify(path.resolve(import.meta.dirname, "questions-rpc.ts")))
    },
  }] : process.env.KYBERN_PERF_FIXTURE === "artifacts" ? [{
    name: "artifact-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!/\/(Markdown|ResponseImage|ChatFileLink)\.tsx$/.test(id)) return
      return code.replace(/"@\/state\/rpc"|"@\/lib\/tauri"/g, JSON.stringify(path.resolve(import.meta.dirname, "artifacts-transport.ts")))
    },
  }] : process.env.KYBERN_PERF_FIXTURE === "prompts" ? [{
    name: "prompts-fixture-transport",
    enforce: "pre",
    transform(code, id) {
      if (!/\/(Thread|ThreadNotes)\.tsx$/.test(id)) return
      return code.replace(/"@\/state\/rpc"/g, JSON.stringify(path.resolve(import.meta.dirname, "prompts-rpc.ts")))
    },
  }] : [],
  build: { rollupOptions: { input: path.resolve(import.meta.dirname, `${process.env.KYBERN_PERF_FIXTURE ?? "rendering"}.html`) } },
})
