// The list cache's file (`listCache.ts`) in the app's document folder.
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import type { ListCacheStorage } from "./listCache";

export function fileStorage(name = "kybern-list-cache.json"): ListCacheStorage {
  if (Platform.OS === "web") return { read: () => null, write: () => {} };
  const file = () => new File(Paths.document, name);
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
      try {
        const target = file();
        if (!target.exists) target.create();
        target.write(text);
      } catch {
        // The next change writes again.
      }
    },
  };
}
