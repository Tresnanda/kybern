// Microsoft's Evergreen WebView2 Runtime bootstrapper for the installer (`scripts/package-windows.ts`,
// `installer.nsi` `InstallWebView2`), kept apart so CI can fetch and check it on its own.
import { execFileSync } from 'node:child_process'
import { statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Microsoft's permanent link to the current bootstrapper (`MicrosoftEdgeWebview2Setup.exe`). */
export const WEBVIEW2_BOOTSTRAPPER_URL = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'

/**
 * The bootstrapper (about 2 MB; it downloads the runtime), for machines without the runtime. Microsoft's redistribution
 * terms allow shipping it. `given` is a copy to use, else it is downloaded into `dir`. With `verify` (a Windows host) its
 * Authenticode signature must be valid and Microsoft's. Without a copy off Windows it is left out (a cross-build is a
 * build test) and `undefined` comes back.
 */
export async function webView2Bootstrapper(dir: string, { given, verify }: { given?: string; verify: boolean }): Promise<string | undefined> {
  if (!given && !verify) { console.log('skipping the WebView2 bootstrapper (not a Windows host; pass --webview2-bootstrapper)'); return undefined }
  const file = given ? path.resolve(given) : path.join(dir, 'MicrosoftEdgeWebview2Setup.exe')
  if (!given) {
    const response = await fetch(WEBVIEW2_BOOTSTRAPPER_URL)
    if (!response.ok) throw Error(`Could not download the WebView2 bootstrapper (${response.status}). Pass --webview2-bootstrapper <file>, or --no-webview2-bootstrapper`)
    writeFileSync(file, new Uint8Array(await response.arrayBuffer()))
  }
  const size = statSync(file).size
  if (size < 500_000 || size > 10_000_000) throw Error(`${file} (${size} bytes) does not look like the WebView2 bootstrapper`)
  if (verify) {
    const check = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}'; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { Write-Output "signature: $($s.Status) $($s.SignerCertificate.Subject)"; exit 1 }`
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { stdio: 'inherit' })
  }
  console.log(`WebView2 bootstrapper: ${file} (${size} bytes)`)
  return file
}
