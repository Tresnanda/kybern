import { randomUUID } from "expo-crypto";
import type { Thread } from "../state/protocol";
import { errorText, getState, refresh, rpc } from "../state/runtime";
import { Alert } from "../ui/Alert";

export function confirmDeleteCoordinator(thread: Thread, onDeleted?: () => void) {
  const activeId = getState().activeId;
  const request = { operation_id: randomUUID(), project_id: thread.project_id, thread_id: thread.id };
  let busy = false;
  async function remove() {
    if (busy) return;
    busy = true;
    try {
      if (getState().activeId !== activeId) throw new Error("The connected computer changed. Reopen the coordinator before deleting it.");
      await rpc("collaboration.coordinator.delete", request);
      if (getState().activeId === activeId) {
        await refresh();
        if (getState().activeId === activeId) onDeleted?.();
      }
    } catch (cause) {
      Alert.alert("Unable to delete coordinator", errorText(cause), [
        { text: "Cancel", style: "cancel" },
        { text: "Retry deletion", style: "destructive", onPress: () => void remove() },
      ]);
    } finally {
      busy = false;
    }
  }
  Alert.alert("Delete coordinator?", "You can create a fresh coordinator afterward. This conversation is archived; worker conversations, results, files, and previous knowledge remain in history. The new coordinator starts with fresh knowledge. Stop active agents and remove queued messages before deleting.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete coordinator", style: "destructive", onPress: () => void remove() },
  ]);
}
