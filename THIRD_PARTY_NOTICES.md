# Third-party notices

## Synara

Source: https://github.com/Emanuele-web04/synara (ported from commit 299fd573b1d6520c323a87c78d30be74e87e53e1)
Used in: apps/gpuix/src/platform/translucency.ts, apps/gpuix/src/native/windowBlur.ts,
apps/gpuix/src/shell/windowMaterial.ts, apps/gpuix/src/kit/Slider.tsx (window
translucency model, material formulas, native blur call). Synara's theme presets are not used.

MIT License

Copyright (c) 2026 T3 Tools Inc.
Copyright (c) 2026 Emanuele Di Pietro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Zeron

Source: https://github.com/zeronsh/zeron (values and techniques taken from commit 911ec56e)
Used in: apps/gpuix/src/platform/glass.ts, apps/gpuix/src/kit/GlassEdge.tsx,
apps/gpuix/src/kit/Segmented.tsx, apps/gpuix/src/platform/translucency.ts (glass recipes: raised, frost and
recess tints, rim and highlight values, the segmented thumb plate, the readability floor). Only values
and techniques are used. Zeron's GPUI fork (ZUI, Apache-2.0/GPL) is not: the native `edgeFade` patch
(edge_fade.rs and the rounded clip chain in the Tresnanda/gpuix and Tresnanda/zed forks, pinned by
apps/gpuix/native/FORK) is written from the idea, with no ZUI code.

MIT License

Copyright (c) 2026 Wing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Microsoft Visual C++ Redistributable (Windows installer)

The Windows installer of Kybern GPUIX carries the app-local Microsoft Visual C++ runtime
(`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140*.dll`) next to its executables, copied from
the Visual Studio redistributable folder (`VC\Redist\MSVC\<version>\x64\Microsoft.VC14x.CRT`)
of the machine that builds the installer. These files are Microsoft software, redistributable
under the terms of the Visual Studio license ("Distributable Code": the Microsoft Visual C++
Redistributable files listed in the REDIST.TXT of the Visual Studio installation). They are not
covered by Kybern's license.

## Microsoft Edge WebView2 (Windows)

`kybern-webview.dll`, the embedded web view of Kybern GPUIX on Windows (`apps/gpuix/native/webview-win`),
statically links the WebView2 loader (`WebView2LoaderStatic.lib` from the Microsoft.Web.WebView2 SDK
1.0.3650.58, shipped in the `webview2-com-sys` crate) and uses the `webview2-com` and `windows` crates
(MIT or Apache-2.0). The WebView2 SDK is Microsoft software under the license in its NuGet package
(Microsoft.Web.WebView2, LICENSE.txt). The Windows installer also carries Microsoft's Evergreen
WebView2 Runtime bootstrapper (`MicrosoftEdgeWebview2Setup.exe`), redistributable under the WebView2
Runtime distribution terms (https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution);
it runs only when the runtime is missing and installs Microsoft's runtime, which Microsoft updates.
These are not covered by Kybern's license.
