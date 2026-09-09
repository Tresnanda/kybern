import { useMemo, type PropsWithChildren } from "react";
import { Platform, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Busy } from "./Busy";
import { Icon } from "./primitives";
import { useTheme } from "./theme";

export function PullRefresh({
  children,
  offset,
  refreshing,
  onRefresh,
}: PropsWithChildren<{
  offset: SharedValue<number>;
  refreshing: boolean;
  onRefresh: () => void;
}>) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const pull = useSharedValue(0);
  const fromTop = useSharedValue(false);
  const gesture = useMemo(
    () =>
      Gesture.Simultaneous(
        Gesture.Native(),
        Gesture.Pan()
          .enabled(!refreshing && Platform.OS === "android")
          .activeOffsetY(12)
          .onBegin(() => {
            fromTop.set(offset.get() <= 1);
          })
          .onUpdate((event) => {
            if (fromTop.get())
              pull.set(
                Math.max(0, event.translationY) /
                  (2 + Math.max(0, event.translationY) / 160),
              );
          })
          .onEnd((event) => {
            if (
              fromTop.get() &&
              (pull.get() > 48 || (pull.get() > 24 && event.velocityY > 1200))
            )
              scheduleOnRN(onRefresh);
          })
          .onFinalize(() => {
            pull.set(withSpring(0, { duration: 300, dampingRatio: 1 }));
          }),
      ),
    [refreshing, fromTop, offset, pull, onRefresh],
  );
  const indicator = useAnimatedStyle(() => ({
    opacity: refreshing ? 1 : Math.min(1, pull.get() / 32),
    transform: [
      { translateY: reduced ? 8 : refreshing ? 16 : pull.get() - 28 },
      {
        scaleX: reduced || refreshing ? 1 : 1 + Math.min(pull.get(), 64) / 256,
      },
    ],
  }));
  if (Platform.OS !== "android") return children;
  return (
    <View style={{ flex: 1 }}>
      <GestureDetector gesture={gesture}>{children}</GestureDetector>
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            top: 0,
            alignSelf: "center",
            width: 48,
            height: 44,
            borderRadius: 24,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.line,
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 4px 16px #00000018",
          },
          indicator,
        ]}
      >
        {refreshing ? (
          <Busy accessibilityLabel="Refreshing threads" />
        ) : (
          <Icon name="arrow.clockwise" size={19} />
        )}
      </Animated.View>
    </View>
  );
}
