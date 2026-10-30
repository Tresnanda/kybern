// The offline cache of every machine's lists (design §5.1), in one JSON file in
// the app's document folder, the way `state/prefs.ts` keeps list preferences.
// Losing it is harmless: machines are listed from their next read instead.
// Writes wait for a quiet moment so a streaming thread does not rewrite it constantly.
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import type { CacheStorage } from "../../../../packages/kybern-client/src/machineCache";

const WRITE_DELAY_MS = 2000;

export function machineCacheFile(name = "kybern-machine-cache.json"): CacheStorage & { flush(): void } {
  if (Platform.OS === "web") return { read: () => null, write: () => {}, flush: () => {} };
  const file = () => new File(Paths.document, name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending === undefined) return;
    const text = pending;
    pending = undefined;
    try {
      const target = file();
      if (!target.exists) target.create();
      target.write(text);
    } catch {
      // The next change writes again.
    }
  };
  return {
    read: () => {
      try {
        const target = file();
        return target.exists ? target.textSync() : null;
      } catch {
        return null;
      }
    },
    write: (text) => {
      pending = text;
      timer ??= setTimeout(flush, WRITE_DELAY_MS);
    },
    flush,
  };
}
