import assert from "node:assert/strict"
import test from "node:test"

import {
  eligibleAtLaunch,
  gpuixErrorParts,
  GPUIX_MANUAL_COMMAND,
  shouldShowGpuixPrompt,
  versionAtLeast,
} from "./src/lib/gpuixPromptRules.ts"

const launch = {
  version: "0.10.0",
  inShell: true,
  supported: true,
  installed: false,
  record: null,
}

test("versions compare numerically and ignore pre-release suffixes", () => {
  assert.equal(versionAtLeast("0.10.0", "0.10.0"), true)
  assert.equal(versionAtLeast("v0.10.1", "0.10.0"), true)
  assert.equal(versionAtLeast("0.9.9", "0.10.0"), false)
  assert.equal(versionAtLeast("0.10.0-beta.1", "0.10.0"), true)
  assert.equal(versionAtLeast("1.0", "0.10.0"), true)
  assert.equal(versionAtLeast("0.9", "0.10.0"), false)
})

test("the invitation needs 0.10.0 or newer on a supported Mac without GPUIX", () => {
  assert.equal(eligibleAtLaunch(launch), true)
  assert.equal(eligibleAtLaunch({ ...launch, version: "0.9.1" }), false)
  assert.equal(eligibleAtLaunch({ ...launch, version: null }), false)
  assert.equal(eligibleAtLaunch({ ...launch, supported: false }), false)
  assert.equal(eligibleAtLaunch({ ...launch, installed: true }), false)
  assert.equal(eligibleAtLaunch({ ...launch, inShell: false }), false)
})

test("a shown or dismissed card never returns", () => {
  assert.equal(eligibleAtLaunch({ ...launch, record: "shown" }), false)
  assert.equal(eligibleAtLaunch({ ...launch, record: "dismissed" }), false)
})

test("the card waits for the first update check and yields to the announcement", () => {
  const facts = { eligible: true, dismissed: false, updateSettled: true, updateOpen: false }
  assert.equal(shouldShowGpuixPrompt(facts), true)
  assert.equal(shouldShowGpuixPrompt({ ...facts, updateSettled: false }), false)
  assert.equal(shouldShowGpuixPrompt({ ...facts, updateOpen: true }), false)
  assert.equal(shouldShowGpuixPrompt({ ...facts, dismissed: true }), false)
  assert.equal(shouldShowGpuixPrompt({ ...facts, eligible: false }), false)
})

test("shell errors split into a message and the manual command", () => {
  const command = "curl -fsSL https://example.com/install.sh | sh"
  assert.deepEqual(
    gpuixErrorParts(`The download failed. To install it yourself, run this in Terminal: ${command}`),
    { message: "The download failed.", command }
  )
  assert.deepEqual(gpuixErrorParts("Something broke"), {
    message: "Something broke",
    command: GPUIX_MANUAL_COMMAND,
  })
})
