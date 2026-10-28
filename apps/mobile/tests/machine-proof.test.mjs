import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
registerHooks({ resolve(specifier, context, next) {
  const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" };
  return next(specifier, context);
} });
const { decodeBase64, verifyMachineProof } = await import("../src/machines/proof.ts");
const { wellKnownProofMessage } = await import("../../../packages/kybern-client/src/machineRoutes.ts");

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const secret = ed25519.utils.randomSecretKey();
const parts = { nonce: "n-1", machineId: "mac", at: "2026-10-29T10:00:00Z", host: "mac.tail.ts.net:4173" };
const input = (over = {}, key = secret) => {
  const message = wellKnownProofMessage({ ...parts, ...over });
  return { signingKey: b64(ed25519.getPublicKey(key)), proof: b64(ed25519.sign(wellKnownProofMessage(parts), key)), message, ...parts, ...over };
};

test("base64 decoding matches Buffer for padded, unpadded and empty text, and refuses everything else", () => {
  for (const bytes of [[], [1], [1, 2], [1, 2, 3], [250, 251, 252, 253, 254, 255, 0]]) {
    const text = b64(bytes);
    assert.deepEqual([...decodeBase64(text)], bytes);
    assert.deepEqual([...decodeBase64(text.replace(/=+$/, ""))], bytes);
  }
  assert.equal(decodeBase64("not base64!"), null);
  assert.equal(decodeBase64("A"), null);
});

test("a signature over the daemon's message verifies, and only for that nonce, machine, time, host and key", () => {
  assert.equal(verifyMachineProof(input()), true);
  for (const over of [{ nonce: "n-2" }, { machineId: "vps" }, { at: "2026-10-29T10:00:01Z" }, { host: "evil.example:4173" }])
    assert.equal(verifyMachineProof(input(over)), false, JSON.stringify(over));
  assert.equal(verifyMachineProof({ ...input(), signingKey: b64(ed25519.getPublicKey(ed25519.utils.randomSecretKey())) }), false);
});

test("malformed keys and signatures are refused, never thrown", () => {
  const good = input();
  assert.equal(verifyMachineProof({ ...good, signingKey: "" }), false);
  assert.equal(verifyMachineProof({ ...good, signingKey: b64(new Uint8Array(31)) }), false);
  assert.equal(verifyMachineProof({ ...good, proof: b64(new Uint8Array(63)) }), false);
  assert.equal(verifyMachineProof({ ...good, proof: "***" }), false);
  assert.equal(verifyMachineProof({ ...good, signingKey: b64(new Uint8Array(32)) }), false, "the all-zero key is not a valid point for this signature");
  const flipped = Buffer.from(good.proof, "base64"); flipped[10] ^= 1;
  assert.equal(verifyMachineProof({ ...good, proof: flipped.toString("base64") }), false);
});
