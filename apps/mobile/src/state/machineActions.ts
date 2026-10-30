// What the Machines screen does through a member of the network (the phone is a
// client with `network:admin`, so it asks the computer it is at, or the nearest
// live member, to change the network). The machine set follows through the
// network's own notifications; each action also asks it to read the network again.
import type {
  FoundMachine,
  MachineCard,
  MachineId,
  NetworkAddResult,
  NetworkStatus,
} from "../../../../packages/kybern-client/src/types";
import { machineHub } from "./runtime";

export class NoMemberError extends Error {
  constructor() {
    super("Connect to a computer on your network first. Machines are managed through it.");
    this.name = "NoMemberError";
  }
}

/** True when a live machine can manage the network for this phone. */
export const canManageNetwork = () => !!machineHub().memberClient();

function member(except?: MachineId) {
  const client = machineHub().memberClient(except);
  if (!client) throw new NoMemberError();
  return client;
}

const follow = async <T>(result: T): Promise<T> => {
  void machineHub().set.syncMembers().catch(() => {});
  return result;
};

export async function networkStatus(): Promise<NetworkStatus> {
  return member().call("network.status", {});
}
export async function addFoundMachine(found: FoundMachine): Promise<NetworkAddResult> {
  return follow(await member().call(found.action === "merge" ? "network.merge" : "network.add", { found_id: found.found_id }) as NetworkAddResult);
}
/** The machine at `address` shows a six-digit code; a member joins it with that code. */
export async function joinWithCode(code: string, address: string): Promise<MachineCard> {
  return follow(await member().call("network.join", { code: code.trim(), address: address.trim() }));
}
/** Remove a machine from the network everywhere. `stolen` also marks it lost. */
export async function removeFromNetwork(machineId: MachineId, stolen: boolean): Promise<void> {
  // Never ask the machine being removed to remove itself.
  await member(machineId).call("network.remove", { machine_id: machineId, ...(stolen ? { stolen: true } : {}) });
  void machineHub().set.syncMembers().catch(() => {});
}
