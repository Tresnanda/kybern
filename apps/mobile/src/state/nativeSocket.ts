/** Native clients use the daemon's existing trusted Kybern app origin. Android
 * otherwise invents an Origin from the server URL, which the browser-origin
 * allowlist correctly rejects. This origin is not a credential: every socket
 * still authenticates with the device token and verifies daemon identity.
 */
export function createNativeSocket(url: string, token: string): WebSocket {
  // TypeScript's global DOM declaration omits React Native's third argument.
  const NativeWebSocket = WebSocket as unknown as new (
    url: string,
    protocols: string[],
    options: { headers: Record<string, string> },
  ) => WebSocket;
  return new NativeWebSocket(url, [], {
    headers: {
      origin: "tauri://localhost",
      Authorization: `Bearer ${token}`,
    },
  });
}
