// Native adaptation of liquid-gooey's shape morph: leading mass, following size,
// a roundness envelope, and content painted separately from the silhouette.
// https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/liquid-gooey
import MaskedView from "@react-native-masked-view/masked-view";
import { BlurView } from "expo-blur";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  useReducedMotion,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../ui/primitives";
import { useTheme } from "../../ui/theme";

export type MenuOrigin = {
  x: number;
  y: number;
  width: number;
  height: number;
};
// liquid-gooey's morph defaults, mapped through speed=2, bounce=.15.
// Separate springs preserve the mass-before-size character without a long wobble.
const SPEED = 2;
const DAMPING = (1 - 1.1 * 0.15) / 0.45;
const MASS = {
  stiffness: 320 * SPEED * SPEED,
  damping: 17 * SPEED * DAMPING,
  mass: 1,
  reduceMotion: ReduceMotion.System,
};
const SIZE = {
  stiffness: 170 * SPEED * SPEED,
  damping: 11.5 * SPEED * DAMPING,
  mass: 1,
  reduceMotion: ReduceMotion.System,
};

export function MorphingMenu({
  origin,
  open,
  onClose,
  onClosed,
  children,
}: {
  origin: MenuOrigin;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  children: ReactNode;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors, dark } = useTheme();
  const reduced = useReducedMotion();
  const [contentHeight, setContentHeight] = useState(0);
  const [shown, setShown] = useState(false);
  const menuWidth = Math.min(width - 32, 320);
  const menuX = width - 16 - menuWidth;
  const menuY = Math.max(insets.top + 4, origin.y - 8);
  const maxHeight = Math.max(44, height - menuY - insets.bottom - 16);
  const menuHeight = Math.min(contentHeight, maxHeight);
  const destinationHeight = useSharedValue(0);
  const measured = useRef(false);
  useEffect(() => {
    if (!menuHeight) return;
    destinationHeight.set(
      measured.current ? withSpring(menuHeight, SIZE) : menuHeight,
    );
    measured.current = true;
  }, [menuHeight, destinationHeight]);
  const blurLeft = Math.max(0, Math.min(origin.x, menuX) - 32);
  const blurTop = Math.max(0, Math.min(origin.y, menuY) - 32);
  const blurRegion = {
    position: "absolute" as const,
    left: blurLeft,
    top: blurTop,
    width:
      Math.min(
        width,
        Math.max(origin.x + origin.width, menuX + menuWidth) + 32,
      ) - blurLeft,
    height:
      Math.min(
        height,
        Math.max(origin.y + origin.height, menuY + menuHeight) + 32,
      ) - blurTop,
  };
  const center = useSharedValue(0);
  const size = useSharedValue(0);
  const corners = useSharedValue(0);
  const fade = useSharedValue(0);
  const ready = shown && contentHeight > 0;
  useEffect(() => {
    if (!ready) return;
    center.set(withSpring(open ? 1 : 0, MASS));
    corners.set(
      withTiming(open ? 1 : 0, {
        duration: 460 / SPEED,
        easing: Easing.bezier(0.3, 1.05, 0.4, 1),
        reduceMotion: ReduceMotion.System,
      }),
    );
    size.set(
      withSpring(open ? 1 : 0, SIZE, (finished) => {
        if (finished && !open && !reduced) scheduleOnRN(onClosed);
      }),
    );
    fade.set(
      withTiming(
        open ? 1 : 0,
        { duration: 140, reduceMotion: ReduceMotion.Never },
        (finished) => {
          if (finished && !open && reduced) scheduleOnRN(onClosed);
        },
      ),
    );
  }, [open, ready, reduced, center, size, corners, fade, onClosed]);
  const shape = useAnimatedStyle(() => {
    const p = reduced ? 1 : size.get();
    const c = reduced ? 1 : center.get();
    const w = Math.max(1, origin.width + (menuWidth - origin.width) * p);
    const h = Math.max(
      1,
      origin.height + (destinationHeight.get() - origin.height) * p,
    );
    const x =
      origin.x +
      origin.width / 2 +
      (menuX + menuWidth / 2 - origin.x - origin.width / 2) * c;
    const y =
      origin.y +
      origin.height / 2 +
      (menuY + destinationHeight.get() / 2 - origin.y - origin.height / 2) * c;
    const round = Math.sin(Math.PI * Math.max(0, Math.min(1, p)));
    const r = Math.min(
      w / 2,
      h / 2,
      origin.width / 2 +
        (28 - origin.width / 2) * corners.get() +
        round * Math.min(w, h) * 0.22,
    );
    return {
      width: w,
      height: h,
      borderRadius: r,
      transform: [{ translateX: x - w / 2 }, { translateY: y - h / 2 }],
    };
  });
  const contentStyle = useAnimatedStyle(() => ({
    opacity: reduced
      ? fade.get()
      : interpolate(size.get(), [0.45, 0.9], [0, 1], "clamp"),
  }));
  const materialStyle = useAnimatedStyle(() => ({
    opacity: reduced ? fade.get() : 1,
  }));
  const dotStyle = useAnimatedStyle(() => ({
    opacity: reduced ? 0 : interpolate(size.get(), [0, 0.25], [1, 0], "clamp"),
  }));
  return (
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      onShow={() => setShown(true)}
      onRequestClose={onClose}
    >
      <View
        style={{ flex: 1 }}
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss thread menu"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, materialStyle]}
        >
          <Animated.View
            style={[
              {
                position: "absolute",
                top: 0,
                left: 0,
                boxShadow: "0 8px 36px #00000025",
                borderWidth: 0.5,
                borderColor: colors.line,
              },
              shape,
            ]}
          />
        </Animated.View>
        <MaskedView
          androidRenderingMode="software"
          pointerEvents="box-none"
          style={StyleSheet.absoluteFill}
          maskElement={
            <Animated.View
              style={[
                {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  backgroundColor: "black",
                },
                shape,
              ]}
            />
          }
        >
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, materialStyle]}
          >
            <BlurView
              intensity={70}
              tint={
                dark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"
              }
              style={blurRegion}
            />
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: dark ? "#202020B8" : "#FFFFFFB8" },
              ]}
            />
          </Animated.View>
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: "absolute",
                left: origin.x,
                top: origin.y,
                width: origin.width,
                height: origin.height,
                alignItems: "center",
                justifyContent: "center",
              },
              dotStyle,
            ]}
          >
            <Icon name="ellipsis" />
          </Animated.View>
          <Animated.View
            pointerEvents={open ? "auto" : "none"}
            accessibilityElementsHidden={!open}
            style={[
              {
                position: "absolute",
                left: menuX,
                top: menuY,
                width: menuWidth,
                maxHeight,
              },
              contentStyle,
            ]}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              bounces={false}
              style={{ maxHeight }}
              onContentSizeChange={(_, h) => setContentHeight(h)}
              contentContainerStyle={{ padding: 10 }}
            >
              {children}
            </ScrollView>
          </Animated.View>
        </MaskedView>
      </View>
    </Modal>
  );
}
