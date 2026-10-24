// One place for haptics, so every moment uses the same call (design-system.md §Haptics).
// Haptics are never the only feedback: each one pairs with a visual change in the
// same frame. Expo Haptics is silent on most Android hardware and when the user
// turned system haptics off; callers never depend on it.
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

const safe = (work: () => Promise<void>) => {
  void work().catch(() => {});
};

export const haptics = {
  /** A value commits: status, priority, criteria toggle, segmented step. */
  select: () => safe(() => Haptics.selectionAsync()),
  /** A swipe crosses its commit threshold, a sheet detent catches. */
  threshold: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** A delete or archive commits. */
  commit: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  /** A task started, a follow-up sent. */
  success: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** An action failed and the screen says why. */
  error: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
  /**
   * A custom (Android) long-press menu opens. iOS native context menus fire
   * their own, so this is a no-op there. Chip switches and scrolling get none.
   */
  menu: () => {
    if (Platform.OS !== "ios") safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
  },
};
