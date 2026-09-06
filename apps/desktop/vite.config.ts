import path from "node:path"
import { createRequire } from "node:module"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: {
    "@": path.resolve(import.meta.dirname, "./src"),
    // Vite workers inherit browser export conditions. The default decoder uses
    // the same entity table without document.createElement, in dev and builds.
    "decode-named-character-reference": createRequire(import.meta.url).resolve("decode-named-character-reference"),
  } },
  worker: { format: "es" },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "safari15",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
