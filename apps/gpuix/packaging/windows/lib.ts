// Pure helpers for `scripts/package-windows.ts` (tested in `lib.test.ts`).

/** `0.15.1` and `0.15.1-rc.1` both become `0.15.1.0`, the four-part number NSIS and the PE header want. */
export function versionQuad(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (!match) throw Error(`Not a release version: ${version}`)
  return `${match[1]}.${match[2]}.${match[3]}.0`
}

/** The release asset name. `updater-manifest.mjs` lists it, and `platform/update.ts` refuses an update whose signature names another file. */
export const installerName = (version: string) => `kybern-gpuix_${version}_x64-setup.exe`

export interface PayloadEntry { name: string; directory: boolean }

// NSIS strings give `$`, quotes and backslashes meaning; the payload never needs them.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/

/**
 * The two includes `installer.nsi` pulls in: one `InstallFile` per top-level
 * file (it moves a locked file aside, and fails the install if the write still fails)
 * and a recursive `File` per top-level folder (same error check; `installer.nsi` moves
 * the files of `bin` aside itself); the uninstaller deletes exactly those, never the whole
 * install folder, which a user may have pointed at something else.
 */
export function nsisIncludes(entries: PayloadEntry[], payload: string): { install: string; uninstall: string } {
  const install: string[] = [], uninstall: string[] = []
  for (const { name, directory } of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!SAFE_NAME.test(name)) throw Error(`Unsupported file name in the Windows payload: ${name}`)
    if (directory) {
      install.push(`SetOutPath "$INSTDIR\\${name}"`, 'SetOverwrite try', 'ClearErrors', `File /r "${payload}\\${name}\\*.*"`, `!insertmacro CheckWrite "${name}"`, 'SetOutPath "$INSTDIR"')
      uninstall.push(`RMDir /r /REBOOTOK "$INSTDIR\\${name}"`)
    } else {
      install.push(`!insertmacro InstallFile "${name}" "${payload}\\${name}"`)
      uninstall.push(`Delete /REBOOTOK "$INSTDIR\\${name}"`)
    }
  }
  return { install: `${install.join('\r\n')}\r\n`, uninstall: `${uninstall.join('\r\n')}\r\n` }
}

/**
 * Where the Microsoft C++ runtime DLLs live inside a Visual Studio install:
 * `<VS>\VC\Redist\MSVC\<version>\x64\Microsoft.VC14x.CRT`. Rust's MSVC targets
 * link it dynamically, so the app carries the DLLs next to its executables
 * (app-local deployment) rather than ask for the redistributable installer.
 */
export function vcRuntimeCandidates(entries: string[]): string[] {
  return entries.filter(name => /^Microsoft\.VC\d+\.CRT$/i.test(name)).sort().reverse()
}

/**
 * The runtime DLLs the Kybern binaries import; whichever of them a toolset ships is copied (into the install
 * folder and into `bin`, which holds `kybern.exe`). `concrt140.dll`, the Concurrency Runtime, is left out: only
 * C++ code that uses PPL or `std::async` imports it, and the Rust crates, Bun and the addon's C dependencies do not.
 */
export const VC_RUNTIME_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll']
