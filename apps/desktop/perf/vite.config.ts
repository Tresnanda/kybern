import path from "node:path"
import { mergeConfig } from "vite"
import base from "../vite.config"
export default mergeConfig(base, {
  plugins: process.env.KYBERN_PERF_FIXTURE === "questions" ? [{
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
      if (!/\/(Markdown|ResponseImage)\.tsx$/.test(id)) return
      return code.replace(/"@\/state\/rpc"|"@\/lib\/tauri"/g, JSON.stringify(path.resolve(import.meta.dirname, "artifacts-transport.ts")))
    },
  }] : [],
  build: { rollupOptions: { input: path.resolve(import.meta.dirname, `${process.env.KYBERN_PERF_FIXTURE ?? "rendering"}.html`) } },
})
