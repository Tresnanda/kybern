import path from "node:path"
import { mergeConfig } from "vite"
import base from "../vite.config"
export default mergeConfig(base, {
  build: { rollupOptions: { input: path.resolve(import.meta.dirname, `${process.env.KYBERN_PERF_FIXTURE ?? "rendering"}.html`) } },
})
