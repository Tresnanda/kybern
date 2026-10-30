// The strip a thread shows above its (locked) composer while it moves to another machine or after it moved
// (design §7.2): "Moving to satyamas…", "This thread continues on satyamas · Open". A move whose answer never came
// back offers "Keep here", which asks the other machine and gives the thread back.
import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { moveBanner } from "../../../../packages/kybern-client/src/continueOn";
import { parseThreadLink } from "../../../../packages/kybern-client/src/forkMachine";
import type { Thread } from "../state/protocol";
import { errorText, rpc } from "../state/runtime";
import { showToast } from "../ui/Toast";
import { Button, T, Tap } from "../ui/primitives";
import { space } from "../ui/theme";

export function MoveBanner({ thread }: { thread?: Thread | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const banner = moveBanner(thread);
  if (!thread || !banner) return null;
  const target = banner.open ? parseThreadLink(banner.open.href) : null;
  async function keep(force: boolean) {
    setBusy(true);
    try {
      const result = await rpc("threads.move_abandon", { thread_id: thread!.id, force });
      if (result.outcome === "completed") showToast(`${banner!.machineName} already had the thread. The move is done.`);
    } catch (e) {
      showToast(`Couldn't give the thread back. ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36 }}>
      <T variant="footnote" style={{ flex: 1 }} numberOfLines={2}>
        {banner.text}
      </T>
      {banner.uncertain ? (
        <Button role="tinted" size="medium" busy={busy} label="Keep this thread here" onPress={() => void keep(false)}>
          Keep here
        </Button>
      ) : null}
      {target ? (
        <Tap
          label={`Open the thread on ${banner.machineName}`}
          onPress={() => router.push({ pathname: "/thread/[id]", params: { id: target.threadId } })}
          style={{ minHeight: 36, justifyContent: "center" }}
        >
          <T variant="footnote" tone="accent">
            {banner.open!.label}
          </T>
        </Tap>
      ) : null}
    </View>
  );
}
