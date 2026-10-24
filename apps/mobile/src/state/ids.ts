import { getRandomValues } from "expo-crypto";
import { uuidv7 } from "../../../../packages/kybern-client/src/newChat";

/** A UUID v7 for a thread or message the client names (`packages/kybern-client/src/newChat.ts`). */
export const newThreadId = () => uuidv7(Date.now(), (bytes) => { getRandomValues(bytes); });
