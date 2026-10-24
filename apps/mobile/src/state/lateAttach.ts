// State modules register their runtime hooks when first imported. A screen may
// import one after the computer connected, so it adopts the live client then.
import type { KybernClient } from "./protocol";
import { currentClient, getState } from "./runtime";

export function attachLate(
  attach: (client: KybernClient, isCurrent: () => boolean) => void,
  ready: () => void,
) {
  const client = currentClient();
  if (!client) return;
  attach(client, () => currentClient() === client);
  if (getState().status === "open") ready();
}
