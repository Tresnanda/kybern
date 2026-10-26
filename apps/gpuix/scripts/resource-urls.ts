/**
 * The Bun.build plugin every packager uses for the compiled app (`package-app.ts` on macOS,
 * `package-windows.ts` on Windows, `package-linux.ts` on Linux). Source files under `src/` find their fonts and artwork with
 * `new URL('./x', import.meta.url)`, which points into Bun's virtual filesystem once compiled; this
 * rewrites that base to the install's resources folder (`KYBERN_GPUIX_RESOURCES`, set by the entry
 * file), where the same relative layout is copied. It also gives the packaged build its app name and,
 * on Linux, the app id (Wayland app_id / X11 WM_CLASS) that matches its desktop entry, so docks group and pin it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

export function resourceUrlPlugin(root: string, options: { appId?: string } = {}): import('bun').BunPlugin {
  const normal = (file: string) => file.replaceAll('\\', '/')
  const src = `${normal(root)}/src/`
  return { name: 'bundle-resource-urls', setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
      const file = normal(args.path)
      if (!file.startsWith(src)) return
      let contents = readFileSync(args.path, 'utf8')
      if (file === `${src}main.tsx`) contents = contents.replace("appName: 'Kybern'", `appName: 'Kybern GPUIX'${options.appId ? `, appId: '${options.appId}'` : ''}`)
      if (contents.includes('import.meta.url')) {
        const relative = normal(path.relative(root, args.path))
        // pathToFileURL escapes spaces, `#` and drive letters; string concatenation does not.
        contents = `import { pathToFileURL as __kybernPathToFileURL } from 'node:url';\n${contents.replaceAll('import.meta.url', `new URL(${JSON.stringify(relative)}, __kybernPathToFileURL(process.env.KYBERN_GPUIX_RESOURCES + '/').href).href`)}`
      }
      return { contents, loader: file.endsWith('tsx') ? 'tsx' : file.endsWith('ts') ? 'ts' : 'js' }
    })
  } }
}
