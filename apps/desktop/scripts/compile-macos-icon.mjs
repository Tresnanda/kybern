import { spawnSync } from "node:child_process"
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "darwin") {
  console.log("Skipping the Icon Composer build outside macOS.")
  process.exit(0)
}

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tauriDir = join(desktopDir, "src-tauri")
const iconSource = resolve(
  desktopDir,
  "../../assets/icon-composer/icon-composer.icon"
)
const iconName = basename(iconSource, ".icon")
const iconsDir = join(tauriDir, "icons")
const tauriConfig = JSON.parse(
  readFileSync(join(tauriDir, "tauri.conf.json"), "utf8")
)
const minimumSystemVersion =
  tauriConfig.bundle?.macOS?.minimumSystemVersion ?? "12.0"
const outputDir = mkdtempSync(join(tmpdir(), "kybern-macos-icon-"))
const workingIcon = join(outputDir, `${iconName}.icon`)
const compileOutputDir = join(outputDir, "compiled")
const partialInfoPlist = join(
  compileOutputDir,
  "assetcatalog_generated_info.plist"
)

try {
  cpSync(iconSource, workingIcon, { recursive: true })
  // Icon Composer metadata can make actool fail when the package is compiled by a child process.
  const clearMetadata = spawnSync("xattr", ["-cr", workingIcon], {
    stdio: "inherit",
  })
  if (clearMetadata.error) {
    throw clearMetadata.error
  }
  if (clearMetadata.status !== 0) {
    throw new Error(`xattr exited with status ${clearMetadata.status}`)
  }

  mkdirSync(compileOutputDir, { recursive: true })
  const result = spawnSync(
    "xcrun",
    [
      "actool",
      workingIcon,
      "--compile",
      compileOutputDir,
      "--platform",
      "macosx",
      "--minimum-deployment-target",
      minimumSystemVersion,
      "--target-device",
      "mac",
      "--app-icon",
      iconName,
      "--include-all-app-icons",
      "--output-partial-info-plist",
      partialInfoPlist,
      "--standalone-icon-behavior",
      "all",
      "--warnings",
      "--errors",
      "--notices",
      "--output-format",
      "human-readable-text",
    ],
    { stdio: "inherit" }
  )

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`actool exited with status ${result.status}`)
  }

  const assetsCatalog = join(compileOutputDir, "Assets.car")
  const fallbackIcon = join(compileOutputDir, `${iconName}.icns`)
  if (!existsSync(assetsCatalog) || !existsSync(fallbackIcon)) {
    throw new Error("actool did not produce Assets.car and the fallback ICNS")
  }

  mkdirSync(iconsDir, { recursive: true })
  copyFileSync(assetsCatalog, join(iconsDir, "Assets.car"))
  copyFileSync(fallbackIcon, join(iconsDir, "icon.icns"))
  console.log(`Compiled ${iconName}.icon for the macOS bundle.`)
} catch (error) {
  console.error(
    "Could not compile the macOS app icon. Install Xcode 26 or newer and select it with xcode-select."
  )
  throw error
} finally {
  rmSync(outputDir, { recursive: true, force: true })
}
