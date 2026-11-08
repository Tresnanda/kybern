// Helpers for tests that run a real KybernClient over a fake socket.
//
// A connected client keeps a repeating heartbeat timer (and a reconnect or open timer while it is not open).
// A test that fails an assertion before reaching its `client.close()` would leave that timer running, and the
// file's process would never exit: CI would sit until its job timeout instead of reporting the failure.
import { after } from "node:test";

/**
 * Call once at the top of a test file. The returned function registers a client and hands it back; every
 * registered client is closed when the file's tests end, whether they passed or failed.
 */
export function trackClients() {
  const clients = [];
  after(() => {
    for (const client of clients) client.close();
  });
  return (client) => {
    clients.push(client);
    return client;
  };
}

/** Resolves once `condition()` is true; rejects after `timeoutMs`. Unlike a fixed wait it does not depend on machine speed. */
export async function until(condition, what = "the condition", timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
