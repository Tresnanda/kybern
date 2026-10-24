// A full-screen image viewer for attached and agent images: pinch to zoom (about the fingers),
// drag when zoomed, double-tap to toggle 2.5×, flick down to close at 1×. Release carries the
// finger's velocity; scale past the limits rubber-bands and recoils (liquid-gooey weight).
import { Image, Modal, View, useWindowDimensions, type ImageSourcePropType } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { DURATION, RECOIL, SHEET, withMomentum } from "../components/liquid/motion";
import { IconButton } from "../ui/primitives";
import { useTheme } from "../ui/theme";

const MAX_SCALE = 5;

export function Lightbox({
  source,
  label,
  onClose,
}: {
  source: ImageSourcePropType | undefined;
  label: string;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const scale = useSharedValue(1);
  const startScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const dismiss = useSharedValue(0);
  const settle = (s: number) => {
    "worklet";
    const clamped = Math.min(MAX_SCALE, Math.max(1, s));
    scale.value = withSpring(clamped, RECOIL);
    if (clamped === 1) {
      x.value = withSpring(0, RECOIL);
      y.value = withSpring(0, RECOIL);
    }
  };
  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
    })
    .onUpdate((event) => {
      const next = startScale.value * event.scale;
      // Past the limits the image follows at a third of the finger: it has weight.
      scale.value = next < 1 ? 1 - (1 - next) / 3 : next > MAX_SCALE ? MAX_SCALE + (next - MAX_SCALE) / 3 : next;
    })
    .onEnd(() => settle(scale.value));
  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((event) => {
      if (scale.value > 1.01) {
        x.value = startX.value + event.translationX;
        y.value = startY.value + event.translationY;
      } else dismiss.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (scale.value > 1.01) {
        const limitX = ((scale.value - 1) * width) / 2;
        const limitY = ((scale.value - 1) * height) / 2;
        x.value = withSpring(Math.max(-limitX, Math.min(limitX, x.value + event.velocityX * 0.15)), withMomentum(RECOIL, event.velocityX));
        y.value = withSpring(Math.max(-limitY, Math.min(limitY, y.value + event.velocityY * 0.15)), withMomentum(RECOIL, event.velocityY));
      } else if (dismiss.value > 120 || event.velocityY > 900) {
        dismiss.value = withTiming(height, { duration: DURATION.exit }, () => scheduleOnRN(onClose));
      } else dismiss.value = withSpring(0, withMomentum(SHEET, event.velocityY));
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => settle(scale.value > 1.01 ? 1 : 2.5));
  const gestures = Gesture.Simultaneous(pinch, pan, doubleTap);
  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value + dismiss.value }, { scale: scale.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: 1 - Math.min(0.6, dismiss.value / 400) }));
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.background }, backdropStyle]} />
        <View style={{ flex: 1 }} accessibilityViewIsModal>
          <GestureDetector gesture={gestures}>
            <Animated.View style={[{ flex: 1 }, imageStyle]}>
              <Image source={source} accessibilityLabel={label} resizeMode="contain" fadeDuration={0} style={{ flex: 1, width: "100%" }} />
            </Animated.View>
          </GestureDetector>
          <View style={{ position: "absolute", top: insets.top + 8, right: 16 }}>
            <IconButton name="xmark" label="Close image" onPress={onClose} />
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
