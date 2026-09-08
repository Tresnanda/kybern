// Reuse the desktop's original artwork. Run from apps/mobile after pnpm install
// in both clients. No additional runtime rendering dependency is needed.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const mobileRequire = createRequire(path.resolve(__dirname, "../package.json"));
const desktopRequire = createRequire(path.resolve(__dirname, "../../desktop/package.json"));
const ts = mobileRequire("typescript");
require.extensions[".tsx"] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), {
 compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText, file);
const React = desktopRequire("react");
const { renderToStaticMarkup } = desktopRequire("react-dom/server");
const icons = require("../../desktop/src/components/kit/Icons.tsx");
function oklchToHex(_, lightness, chroma, hue) {
 const angle = Number(hue) * Math.PI / 180;
 const a = Number(chroma) * Math.cos(angle), b = Number(chroma) * Math.sin(angle), L = Number(lightness);
 const l = (L + .3963377774 * a + .2158037573 * b) ** 3;
 const m = (L - .1055613458 * a - .0638541728 * b) ** 3;
 const s = (L - .0894841775 * a - 1.291485548 * b) ** 3;
 const channels = [4.0767416621*l - 3.3077115913*m + .2309699292*s, -1.2684380046*l + 2.6097574011*m - .3413193965*s, -.0041960863*l - .7034186147*m + 1.707614701*s];
 return "#" + channels.map(v => Math.round(Math.max(0, Math.min(1, v <= .0031308 ? 12.92*v : 1.055*v**(1/2.4)-.055))*255).toString(16).padStart(2,"0")).join("");
}
const marks = {};
for (const [kind, name] of Object.entries({ "claude-code": "ClaudeAI", codex: "OpenAI", cursor: "CursorIcon", pi: "PiIcon", omp: "OmpIcon", opencode: "OpenCodeIcon" })) {
 marks[kind] = renderToStaticMarkup(React.createElement(icons[name])).replace(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g, oklchToHex);
}
marks.opencodeDark = fs.readFileSync(path.resolve(__dirname, "../../desktop/public/central-icons-reversed/opencode.svg"), "utf8");
fs.writeFileSync(path.resolve(__dirname, "../src/generated/provider-marks.json"), JSON.stringify(marks, null, 2) + "\n");
fs.copyFileSync(path.resolve(__dirname, "../../desktop/src-tauri/icons/icon.png"), path.resolve(__dirname, "../assets/icon.png"));
