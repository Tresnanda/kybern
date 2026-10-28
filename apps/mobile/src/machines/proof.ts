// The identity-document check of design §3.2: an Ed25519 signature over the
// nonce this phone sent, so an address that merely repeats a machine's public
// key cannot pass for it. `@noble/curves` is pure JavaScript (React Native has
// no Ed25519 primitive and no `crypto.subtle`), audited, and has one dependency.
import { ed25519 } from "@noble/curves/ed25519.js";
import type { ProofInput } from "../../../../packages/kybern-client/src/machineRoutes";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));

/** Standard base64, padded or not; null for anything else. */
export function decodeBase64(text: string): Uint8Array | null {
  const body = text.replace(/=+$/, "");
  if (body.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of body) {
    const index = LOOKUP.get(char);
    if (index === undefined) return null;
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

export function verifyMachineProof(input: ProofInput): boolean {
  try {
    const key = decodeBase64(input.signingKey);
    const signature = decodeBase64(input.proof);
    if (!key || key.length !== 32 || !signature || signature.length !== 64) return false;
    return ed25519.verify(signature, input.message, key);
  } catch {
    return false;
  }
}
