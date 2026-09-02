// Endpoint persistence in the OS keychain / keystore.

import * as SecureStore from "expo-secure-store";
import type { Endpoint } from "@/protocol";

const URL_KEY = "kybern.endpoint.url";
const TOKEN_KEY = "kybern.endpoint.token";

export async function loadEndpoint(): Promise<Endpoint | null> {
  const [url, token] = await Promise.all([SecureStore.getItemAsync(URL_KEY), SecureStore.getItemAsync(TOKEN_KEY)]);
  if (!url || !token) return null;
  return { url, token };
}

export async function saveEndpoint(ep: Endpoint): Promise<void> {
  await Promise.all([SecureStore.setItemAsync(URL_KEY, ep.url), SecureStore.setItemAsync(TOKEN_KEY, ep.token)]);
}

export async function clearEndpoint(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(URL_KEY), SecureStore.deleteItemAsync(TOKEN_KEY)]);
}
