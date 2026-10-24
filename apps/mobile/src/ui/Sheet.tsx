// Sheets are routes. Declare a screen with `sheetOptions()` and it presents as:
//   iOS      a native formSheet: detents, grabber, Liquid Glass at a partial
//            detent, system drag and dismissal.
//   Android  AndroidSheet (ui/AndroidNavigation.tsx): an opaque `surface` sheet,
//            top radius 28, 32 % scrim, a grabber, drag to dismiss carrying the
//            release velocity, and the liquid-gooey outline on entry and drag.
// The sheet's own header (title + close on Android, "Cancel" on iOS) comes
// from the screen's options; a short form puts its primary action in the
// header on iOS and in a bottom bar on Android.
import { Platform, View } from "react-native";
import { useTheme } from "./theme";


/** Detents for a sheet route: phone sheets open at 75 % and can grow; tablets fill. */
export function sheetDetents(windowWidth: number, compact = 0.75) {
  return windowWidth >= 700 ? [1] : [compact, 1];
}

/** Stack.Screen options that present a route as the platform sheet. */
export function sheetOptions({
  title,
  detents = [0.75, 1],
}: {
  title?: string;
  detents?: number[];
} = {}) {
  return Platform.OS === "android"
    ? {
        ...(title != null ? { title } : null),
        presentation: "transparentModal" as const,
        headerShown: false,
        animation: "none" as const,
        contentStyle: { backgroundColor: "transparent" },
        sheetAllowedDetents: detents,
      }
    : {
        ...(title != null ? { title } : null),
        presentation: "formSheet" as const,
        sheetAllowedDetents: detents,
        sheetGrabberVisible: true,
      };
}

/** The Android sheet's grabber: 4 × 32, centred, `line` on `surface`. */
export function SheetGrabber() {
  const { colors } = useTheme();
  return (
    <View
      accessible={false}
      style={{ alignItems: "center", paddingTop: 8, paddingBottom: 2 }}
    >
      <View style={{ width: 32, height: 4, borderRadius: 2, backgroundColor: colors.line }} />
    </View>
  );
}
