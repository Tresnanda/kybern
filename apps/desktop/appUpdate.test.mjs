import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import test from "node:test"

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@tauri-apps/plugin-updater")
      return { shortCircuit: true, url: "update-fixture:updater" }
    if (specifier === "@tauri-apps/plugin-process")
      return { shortCircuit: true, url: "update-fixture:process" }
    if (specifier === "@tauri-apps/api/app")
      return { shortCircuit: true, url: "update-fixture:app" }
    if (specifier === "sonner")
      return { shortCircuit: true, url: "update-fixture:sonner" }
    const url = specifier.startsWith("@/")
      ? new URL("./src/" + specifier.slice(2), import.meta.url)
      : specifier.startsWith(".") && context.parentURL
        ? new URL(specifier, context.parentURL)
        : null
    if (
      url &&
      !/\.[a-z]+$/i.test(url.pathname) &&
      existsSync(fileURLToPath(url) + ".ts")
    ) {
      return { shortCircuit: true, url: url.href + ".ts" }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === "update-fixture:updater")
      return {
        shortCircuit: true,
        format: "module",
        source:
          "export const check = (options) => globalThis.updateFixture.check(options)",
      }
    if (url === "update-fixture:process")
      return {
        shortCircuit: true,
        format: "module",
        source:
          "export const relaunch = () => globalThis.updateFixture.relaunch()",
      }
    if (url === "update-fixture:app")
      return {
        shortCircuit: true,
        format: "module",
        source: "export const getVersion = () => '0.3.9'",
      }
    if (url === "update-fixture:sonner")
      return {
        shortCircuit: true,
        format: "module",
        source:
          "export const toast = Object.assign(() => globalThis.updateFixture.toasts++, { error: (...args) => globalThis.updateFixture.errors.push(args) })",
      }
    if (url.endsWith("/src/lib/tauri.ts"))
      return {
        shortCircuit: true,
        format: "module",
        source: "export const isTauri = () => true",
      }
    if (url.endsWith("/src/lib/hot.ts"))
      return {
        shortCircuit: true,
        format: "module",
        source: "export const reloadOnHotUpdate = () => {}",
      }
    return next(url, context)
  },
})

const stored = new Map()
globalThis.localStorage = {
  getItem(key) {
    return stored.get(key) ?? null
  },
  setItem(key, value) {
    stored.set(key, String(value))
  },
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function nativeUpdate(version, { install } = {}) {
  return {
    version,
    body: `Notes for ${version}`,
    closeCalls: 0,
    installCalls: 0,
    async close() {
      this.closeCalls++
    },
    async downloadAndInstall(onEvent) {
      this.installCalls++
      onEvent({ event: "Started", data: { contentLength: 10 } })
      onEvent({ event: "Progress", data: { chunkLength: 15 } })
      if (install) await install.promise
      onEvent({ event: "Finished", data: {} })
    },
  }
}

function fixture(check) {
  globalThis.updateFixture = {
    check,
    errors: [],
    toasts: 0,
    relaunchCalls: 0,
    async relaunch() {
      this.relaunchCalls++
    },
  }
}

test("detection announces without a toast, dismissal persists, and a newer version announces", async () => {
  stored.clear()
  const first = nativeUpdate("0.4.0")
  fixture(async () => first)
  const updates = await import("./src/lib/appUpdate.ts?announcement")

  await updates.checkForAppUpdate()
  assert.equal(updates.useAppUpdate.getState().announcementOpen, true)
  assert.equal(globalThis.updateFixture.toasts, 0)
  updates.dismissUpdateAnnouncement()
  assert.equal(updates.useAppUpdate.getState().announcementOpen, false)

  const same = nativeUpdate("0.4.0")
  globalThis.updateFixture.check = async () => same
  await updates.checkForAppUpdate()
  assert.equal(updates.useAppUpdate.getState().announcementOpen, false)
  assert.equal(first.closeCalls, 1)

  const afterReload = nativeUpdate("0.4.0")
  globalThis.updateFixture.check = async () => afterReload
  const reloaded = await import("./src/lib/appUpdate.ts?announcement-reload")
  await reloaded.checkForAppUpdate()
  assert.equal(reloaded.useAppUpdate.getState().announcementOpen, false)

  const newer = nativeUpdate("0.5.0")
  globalThis.updateFixture.check = async () => newer
  await reloaded.checkForAppUpdate()
  assert.equal(reloaded.useAppUpdate.getState().announcementOpen, true)
  reloaded.openUpdateDetails()
  assert.equal(reloaded.useAppUpdate.getState().detailsOpen, true)
  assert.equal(reloaded.useAppUpdate.getState().announcementOpen, false)
  reloaded.closeUpdateDetails()
  assert.equal(reloaded.useAppUpdate.getState().detailsOpen, false)
  reloaded.openUpdateDetails()
  assert.equal(
    reloaded.useAppUpdate.getState().detailsOpen,
    true,
    "known release details did not reopen"
  )

  const newest = nativeUpdate("0.6.0")
  globalThis.updateFixture.check = async () => newest
  await reloaded.checkForAppUpdate()
  assert.equal(reloaded.useAppUpdate.getState().version, "0.6.0")
  assert.equal(reloaded.useAppUpdate.getState().detailsOpen, true)
  assert.equal(reloaded.useAppUpdate.getState().announcementOpen, true)
  reloaded.closeUpdateDetails()
  assert.equal(
    reloaded.useAppUpdate.getState().announcementOpen,
    true,
    "a newer release discovered behind open details was never announced"
  )
})

test("unavailable app-local storage never blocks update controls", async () => {
  const availableStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem() {
      throw new Error("storage denied")
    },
    setItem() {
      throw new Error("storage denied")
    },
  }
  try {
    const update = nativeUpdate("0.7.0")
    fixture(async () => update)
    const updates = await import("./src/lib/appUpdate.ts?storage-denied")
    await updates.checkForAppUpdate()
    assert.equal(updates.useAppUpdate.getState().announcementOpen, true)
    assert.doesNotThrow(() => updates.dismissUpdateAnnouncement())
    await updates.checkForAppUpdate()
    assert.equal(
      updates.useAppUpdate.getState().announcementOpen,
      false,
      "the same release reopened during this session"
    )
    updates.openUpdateDetails()
    assert.equal(updates.useAppUpdate.getState().detailsOpen, true)
  } finally {
    globalThis.localStorage = availableStorage
  }
})

test("a failed recheck preserves the pending update and remains retryable", async () => {
  stored.clear()
  const update = nativeUpdate("0.4.1")
  fixture(async () => update)
  const updates = await import("./src/lib/appUpdate.ts?failure")
  await updates.checkForAppUpdate()

  globalThis.updateFixture.check = async () => {
    throw new Error("network offline")
  }
  await updates.checkForAppUpdate({ manual: true })
  const state = updates.useAppUpdate.getState()
  assert.equal(state.phase, "available")
  assert.equal(state.version, "0.4.1")
  assert.equal(state.notes, "Notes for 0.4.1")
  assert.match(state.error, /release feed is unavailable/)
  assert.equal(state.errorKind, "check")
  assert.equal(globalThis.updateFixture.errors.length, 1)

  const install = updates.installAppUpdate()
  assert.equal(updates.useAppUpdate.getState().errorKind, null)
  await install
  assert.equal(update.installCalls, 1)
  assert.equal(globalThis.updateFixture.relaunchCalls, 1)
})

test("install waits for a recheck, never closes an installing resource, and deduplicates requests", async () => {
  stored.clear()
  const original = nativeUpdate("0.4.0")
  fixture(async () => original)
  const updates = await import("./src/lib/appUpdate.ts?race")
  await updates.checkForAppUpdate()

  const checking = deferred()
  const replacementInstall = deferred()
  const replacement = nativeUpdate("0.5.0", { install: replacementInstall })
  globalThis.updateFixture.check = () => checking.promise
  const checkPromise = updates.checkForAppUpdate()
  const installA = updates.installAppUpdate()
  const installB = updates.installAppUpdate()
  assert.equal(original.installCalls, 0)

  checking.resolve(replacement)
  await checkPromise
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(original.closeCalls, 1)
  assert.equal(replacement.installCalls, 1)
  assert.equal(updates.useAppUpdate.getState().phase, "installing")
  assert.equal(
    updates.useAppUpdate.getState().progress,
    1,
    "oversized progress is bounded"
  )

  const checkDuringInstall = updates.checkForAppUpdate()
  assert.equal(replacement.closeCalls, 0)
  replacementInstall.resolve()
  await Promise.all([installA, installB, checkDuringInstall])
  assert.equal(replacement.installCalls, 1)
  assert.equal(globalThis.updateFixture.relaunchCalls, 1)
  await updates.installAppUpdate()
  assert.equal(
    replacement.installCalls,
    1,
    "completed install ran twice while awaiting relaunch"
  )
})

test("a failed install returns to available and can be retried", async () => {
  stored.clear()
  let attempt = 0
  const update = nativeUpdate("0.4.2")
  update.downloadAndInstall = async () => {
    update.installCalls++
    if (++attempt === 1) throw new Error("signature service unavailable")
  }
  fixture(async () => update)
  const updates = await import("./src/lib/appUpdate.ts?retry")
  await updates.checkForAppUpdate()
  await updates.installAppUpdate()
  assert.equal(updates.useAppUpdate.getState().phase, "available")
  assert.match(
    updates.useAppUpdate.getState().error,
    /signature service unavailable/
  )
  assert.equal(updates.useAppUpdate.getState().errorKind, "install")
  await updates.checkForAppUpdate()
  assert.equal(
    updates.useAppUpdate.getState().errorKind,
    null,
    "a successful recheck retained an old install error"
  )
  const retry = updates.installAppUpdate()
  assert.equal(updates.useAppUpdate.getState().errorKind, null)
  await retry
  assert.equal(update.installCalls, 2)
  assert.equal(globalThis.updateFixture.relaunchCalls, 1)
})
