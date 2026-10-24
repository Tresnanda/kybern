// The Android trigger of a long-press menu around readable content (an answer, your message).
// Unlike `Tap` it adds no button role or label, so TalkBack still reads the words inside and
// announces the long-press action. iOS gets the native context menu from `ContextMenu` instead.
import type { ReactNode } from "react";
import { Pressable, type GestureResponderEvent } from "react-native";

export function LongPressArea({
  onLongPress,
  hint,
  children,
}: {
  onLongPress?: (event: GestureResponderEvent) => void;
  hint: string;
  children: ReactNode;
}) {
  if (!onLongPress) return <>{children}</>;
  return (
    <Pressable onLongPress={onLongPress} accessibilityHint={hint} delayLongPress={350}>
      {children}
    </Pressable>
  );
}
