// The delayed loading indicator (#248, `syncIndicator.ts`): nothing for a load that answers within
// 400 ms, and once shown it stays at least 400 ms. A screen that has a cached copy on screen never
// starts it, so a recently seen thread opens with no spinner at all.
import { useEffect, useRef, useState } from "react";
import { createSyncIndicator, type SyncIndicator } from "../../../../packages/kybern-client/src/syncIndicator";

export function useSyncIndicator(busy: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const indicator = useRef<SyncIndicator | null>(null);
  indicator.current ??= createSyncIndicator({ onChange: setVisible });
  useEffect(() => () => indicator.current?.dispose(), []);
  useEffect(() => {
    if (busy) indicator.current?.start();
    else indicator.current?.stop();
  }, [busy]);
  return visible;
}
