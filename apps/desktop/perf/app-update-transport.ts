// The native fixture keeps the production update store and UI, replacing only
// the packaged updater/install boundary so it cannot download, install, or relaunch.
export {
  checkForAppUpdate,
  closeUpdateDetails,
  dismissUpdateAnnouncement,
  loadAppVersion,
  openUpdateDetails,
  startAppUpdateChecks,
  useAppUpdate,
} from "../src/lib/appUpdate"

import { useAppUpdate } from "../src/lib/appUpdate"

export const canSelfUpdate = () => true

export const fixtureInstall = {
  attempts: 0,
  failNext: false,
  reset() {
    this.attempts = 0
    this.failNext = false
  },
}

export async function installAppUpdate(): Promise<void> {
  fixtureInstall.attempts += 1
  useAppUpdate.setState({
    phase: "installing",
    progress: 0.42,
    error: null,
    errorKind: null,
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 180))
  if (fixtureInstall.failNext) {
    fixtureInstall.failNext = false
    useAppUpdate.setState({
      phase: "available",
      progress: null,
      error: "The update could not be verified. Try again.",
      errorKind: "install",
    })
    return
  }
  // Remain in progress so the fixture can verify the disabled install state.
  useAppUpdate.setState({
    phase: "installing",
    progress: 0.68,
    errorKind: null,
  })
}
