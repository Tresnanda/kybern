import path from "node:path"
import { readFileSync } from "node:fs"
import { mergeConfig } from "vite"
import base from "../vite.config"
export default mergeConfig(base, {
  define: {
    __INTEGRATION_PREVIEW_URLS__: process.env.KYBERN_INTEGRATION_PREVIEW_URLS ?? "[]",
    __WORK_REPLAY__: process.env.KYBERN_WORK_REPLAY ? readFileSync(process.env.KYBERN_WORK_REPLAY, "utf8") : "[]",
    __SCROLL_SCENARIO__: JSON.stringify(process.env.KYBERN_SCROLL_SCENARIO ?? ""),
    __SCROLL_FRAMES__: JSON.stringify(Number(process.env.KYBERN_SCROLL_FRAMES ?? 100)),
    __SCROLL_MEMORY__: JSON.stringify(process.env.KYBERN_SCROLL_MEMORY === "1"),
    __COMPOSER_STACK_MODE__: JSON.stringify(process.env.KYBERN_COMPOSER_STACK_MODE ?? "queue"),
  },
  plugins: process.env.KYBERN_PERF_FIXTURE === "history" ? [{
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
