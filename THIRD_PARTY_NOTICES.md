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

## JetBrains Mono (fonts)

Source: https://github.com/JetBrains/JetBrainsMono (Regular, Light, Medium and their italics: version 2.211;
SemiBold and Bold: release v2.304, `JetBrainsMono-2.304.zip`, `fonts/ttf/`)
Used in: apps/gpuix/src/assets/fonts/JetBrainsMono-*.ttf. Kybern GPUIX draws code with them on Windows and Linux and
the terminal and artifacts with them on every OS. The files are unmodified. SHA-256 of the v2.304 files (identical to
the blobs at the repository's `v2.304` tag):

- `JetBrainsMono-SemiBold.ttf`: 1b3bfa1ed5665a4ce3f9feb68d2d4e40e70bf8b4b7d9a3edd418f321b4e166a0
- `JetBrainsMono-Bold.ttf`: 5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb

Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1, the text of which is reproduced in
full in the Inter section below and is also available with a FAQ at: https://openfontlicense.org

## Cal Sans (font)

Source: https://github.com/calcom/font (`CalSans-Regular.ttf`, version 1.000)
Used in: apps/gpuix/src/assets/fonts/CalSans-Regular.ttf, the sidebar's brand wordmark. The file is unmodified.

Copyright 2021 The Cal Sans Project Authors (https://github.com/calcom/font)

This Font Software is licensed under the SIL Open Font License, Version 1.1, the text of which is reproduced in
full in the Inter section below and is also available with a FAQ at: https://openfontlicense.org

## Inter (fonts, Windows and Linux)

Source: https://github.com/rsms/inter (release v4.1, `Inter-4.1.zip`: `InterVariable.ttf`, `InterVariable-Italic.ttf`)
Used in: apps/gpuix/src/assets/fonts/InterVariable.ttf, apps/gpuix/src/assets/fonts/InterVariable-Italic.ttf. Kybern GPUIX
registers them on Windows and Linux and draws the system UI font (`.SystemUIFont`) with them there, so the kit's
weights land on a `wght` axis (`src/platform/fonts.ts`); Windows 11 uses Segoe UI Variable instead. The files are
unmodified.

Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION AND CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

## WPE WebKit (Linux packages)

The Linux packages of Kybern GPUIX (AppImage, .deb, .rpm) carry a private build of WPE WebKit 2.54.2 under
`resources/wpe/` for the embedded web view (WP10). It is built from the unmodified upstream tarball
https://wpewebkit.org/releases/wpewebkit-2.54.2.tar.xz (SHA-256
`f3284e19e47fcb5ac8c63c2e1c113dbd65b2423eb8a545f5b345707829004f56`) plus the patches in
`apps/gpuix/native/wpe/` of this repository, by `apps/gpuix/native/wpe/build-wpe.sh`; `resources/wpe/SOURCES.txt`
repeats this. WebKit's WebCore and parts of JavaScriptCore are licensed under the GNU Lesser General Public License,
version 2.1 or later; the rest is under BSD-style licenses. Kybern links `libWPEWebKit-2.0.so.1` dynamically through
its companion `libkybern-webview.so`, so the library can be replaced. The complete licence texts are in
`resources/wpe/licenses/wpewebkit/`. The source code of this exact build is the tarball and patches above; on request
we provide it on a physical medium for no more than the cost of distribution, for three years after the release.

The same folder holds libraries WPE WebKit needs that a distribution may lack, copied from Ubuntu 22.04 packages
(ICU, libsoup 3, libxml2, libxslt, libwebp, libjpeg-turbo, Little CMS, libepoxy, libseccomp, libpsl, nghttp2,
HarfBuzz ICU, libidn2, libunistring, PCRE, libbsd, libmd, and GCC's libatomic, which is GPL-3 with the GCC Runtime
Library Exception), and `resources/wpe/lib/wpe-webkit-2.0/bwrap`, the bubblewrap
sandbox from Ubuntu 22.04's `bubblewrap` package. Each one's licence is its Debian copyright file in
`resources/wpe/licenses/`, and `resources/wpe/SOURCES.txt` names the exact Ubuntu package version each file came
from; their sources are those versions' Ubuntu 22.04 (jammy) source packages at https://launchpad.net/ubuntu/jammy.

Several of them are under the GNU licences:

- **libsoup 3**: GNU Lesser General Public License, version 2 or later.
- **libseccomp**: GNU Lesser General Public License, version 2.1.
- **libidn2**: GNU Lesser General Public License, version 3 or later, or GNU General Public License, version 2 or
  later, at your choice (the library; Kybern ships no libidn2 tools).
- **libunistring**: GNU Lesser General Public License, version 3 or later, or GNU General Public License, version 2
  or later, at your choice.
- **bubblewrap** (`bwrap`): GNU Lesser General Public License, version 2 or later. It is a separate program that
  WPE WebKit runs to sandbox its web processes.

The libraries are linked dynamically and sit as separate files, so each can be replaced. For every component in this
section under a GNU licence (WPE WebKit, libsoup, libseccomp, libidn2, libunistring, bubblewrap), the written offer
above applies too: on request we provide the complete corresponding source of the exact version we ship (as named in
`SOURCES.txt`) on a physical medium for no more than the cost of distribution, for three years after the release.
