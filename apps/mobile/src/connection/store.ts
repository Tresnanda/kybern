// Atomic endpoint persistence in the OS keychain / keystore.
import * as SecureStore from "expo-secure-store";
import type { Endpoint } from "@/protocol";
const KEY = "kybern.endpoint.v2";
const LEGACY = ["kybern.endpoint.url", "kybern.endpoint.token"];

export async function loadEndpoint(): Promise<Endpoint | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (raw) {
    const endpoint = JSON.parse(raw) as Endpoint;
    if (typeof endpoint.url === "string" && typeof endpoint.token === "string") return endpoint;
    return null;
  }
  const [url, token] = await Promise.all(LEGACY.map((key) => SecureStore.getItemAsync(key)));
  return url && token ? { url, token } : null;
}
export async function saveEndpoint(endpoint: Endpoint): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(endpoint));
  await Promise.all(LEGACY.map((key) => SecureStore.deleteItemAsync(key)));
}
export async function clearEndpoint(): Promise<void> {
  await Promise.all([KEY, ...LEGACY].map((key) => SecureStore.deleteItemAsync(key)));
}
