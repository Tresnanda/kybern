// Where a trigger sits, in the coordinates an overlay (a menu's Modal) draws in.
//
// `measureInWindow` is the wrong tool on Android: React Native subtracts the
// status bar from it whenever its own edge-to-edge flag is off, while a Modal
// with `statusBarTranslucent` draws from the top of the screen. That put every
// themed menu one status bar too high (the thread "…" menu over the status bar).
// `measure` reports the position inside the app's root view on both platforms;
// `useOverlayOffset` adds where that root view starts on screen (the status bar
// when the app does not draw edge to edge, as in Expo Go on some phones).
import { Platform, StatusBar, type View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type TriggerRect = { x: number; y: number; width: number; height: number };

/** Measures a trigger relative to the app's root view. */
export function measureTrigger(view: View | null, done: (rect: TriggerRect) => void) {
  view?.measure((_x, _y, width, height, pageX, pageY) => {
    if (width || height) done({ x: pageX, y: pageY, width, height });
  });
}

/** How far below the screen's top the app's root view starts (0 on iOS and edge to edge). */
export function useOverlayOffset() {
  const insets = useSafeAreaInsets();
  if (Platform.OS !== "android") return 0;
  return Math.max(0, (StatusBar.currentHeight ?? 0) - insets.top);
}
