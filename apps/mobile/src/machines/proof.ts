// The identity-document check of design §3.2 (an Ed25519 signature) for routes of
// machines that are members of the network.
//
// TODO(N7 part 2): verify the signature once the phone pairs with members. React
// Native has no Ed25519 primitive in this app's dependencies; add a vetted one
// (socket.dev first) or have a member check on the phone's behalf. Until then no
// record is a member (`records.ts`), so this is never reached, and it refuses
// everything so a member record cannot connect unverified.
import type { ProofInput } from "../../../../packages/kybern-client/src/machineRoutes";

export function verifyMachineProof(_input: ProofInput): boolean {
  return false;
}
