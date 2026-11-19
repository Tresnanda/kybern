// In place of the composer while a thread is archived: the thread reads but takes no messages. Unarchive brings it back
// as idle, and the composer returns with the thread's next update.
import { useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { Button } from "../ui/primitives";
import { gutter } from "../ui/theme";
import { unarchiveThread } from "./threadActions";

export function ArchivedBar({ threadId, disabled }: { threadId: string; disabled?: boolean }) {
  const { width } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  return (
    <View style={{ paddingHorizontal: gutter(width), paddingVertical: 8, width: "100%", maxWidth: 760, alignSelf: "center" }}>
      <Button
        icon="tray.and.arrow.up"
        busy={busy}
        disabled={disabled}
        onPress={() => {
          setBusy(true);
          void unarchiveThread(threadId).finally(() => setBusy(false));
        }}
      >
        Unarchive
      </Button>
    </View>
  );
}
