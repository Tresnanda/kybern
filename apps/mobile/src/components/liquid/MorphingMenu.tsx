// Native adaptation of liquid-gooey's shape morph: leading mass, following size,
// a roundness envelope, and content painted separately from the silhouette.
// https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/liquid-gooey
import MaskedView from "@react-native-masked-view/masked-view";
import { BlurView } from "expo-blur";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Modal,
  Platform,
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
  useDerivedValue,
  useReducedMotion,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../ui/primitives";
import type { IconName } from "../../ui/icons";
import { useTheme } from "../../ui/theme";

export type MenuOrigin = {
  x: number;
  y: number;
  width: number;
  height: number;
};
import { MASS, SIZE } from "./motion";
const SPEED = 2;
const ATTACHMENT_EXIT = {
  duration: 220,
  easing: Easing.bezier(0.4, 0, 0.2, 1),
  reduceMotion: ReduceMotion.System,
};

export function MorphingMenu({
  origin,
  open,
  onClose,
  onClosed,
  children,
  placement = "below",
  sourceIcon = "ellipsis",
  dismissLabel = "Dismiss thread menu",
  preferredWidth = 272,
  closingMotion = "spring",
}: {
  origin: MenuOrigin;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  children: ReactNode;
  placement?: "above" | "below";
  sourceIcon?: IconName;
  dismissLabel?: string;
  preferredWidth?: number;
  closingMotion?: "spring" | "attachment";
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors, dark } = useTheme();
  const reduced = useReducedMotion();
  const [contentHeight, setContentHeight] = useState(0);
  const [shown, setShown] = useState(false);
  const menuWidth = Math.min(width - 32, preferredWidth);
  const menuX =
    placement === "above"
      ? Math.max(16, Math.min(origin.x, width - 16 - menuWidth))
      : width - 16 - menuWidth;
  const belowY = Math.max(insets.top + 4, origin.y - 8);
  const maxHeight = Math.max(
    44,
    placement === "above"
      ? origin.y - insets.top - 16
      : height - belowY - insets.bottom - 16,
  );
  const menuHeight = Math.min(contentHeight, maxHeight);
  const menuY =
    placement === "above"
      ? Math.max(insets.top + 4, origin.y - menuHeight - 8)
      : belowY;
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
  const attachmentExit = closingMotion === "attachment";
  useEffect(() => {
    if (!ready) return;
    // The attachment menu needs a bounded return before opening its picker.
    // Other menus retain their original leading-mass/following-size springs.
    const boundedExit = !open && attachmentExit;
    center.set(
      boundedExit
        ? withTiming(0, ATTACHMENT_EXIT)
        : withSpring(open ? 1 : 0, MASS),
    );
    corners.set(
      withTiming(open ? 1 : 0, {
        duration: boundedExit ? ATTACHMENT_EXIT.duration : 460 / SPEED,
        easing: boundedExit
          ? ATTACHMENT_EXIT.easing
          : Easing.bezier(0.3, 1.05, 0.4, 1),
        reduceMotion: ReduceMotion.System,
      }),
    );
    size.set(
      boundedExit
        ? withTiming(0, ATTACHMENT_EXIT, (finished) => {
            if (finished && !reduced) scheduleOnRN(onClosed);
          })
        : withSpring(open ? 1 : 0, SIZE, (finished) => {
            if (finished && !open && !reduced) scheduleOnRN(onClosed);
          }),
    );
    fade.set(
      withTiming(
        open ? 1 : 0,
        {
          duration: boundedExit && !reduced ? ATTACHMENT_EXIT.duration : 140,
          ...(attachmentExit ? { easing: ATTACHMENT_EXIT.easing } : {}),
          reduceMotion: ReduceMotion.Never,
        },
        (finished) => {
          if (finished && !open && reduced) scheduleOnRN(onClosed);
        },
      ),
    );
  }, [open, ready, reduced, attachmentExit, center, size, corners, fade, onClosed]);
  const geometry = useDerivedValue(() => {
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
    return { width: w, height: h, radius: r, x: x - w / 2, y: y - h / 2 };
  });
  const shape = useAnimatedStyle(() => {
    const g = geometry.get();
    return {
      width: g.width,
      height: g.height,
      borderRadius: g.radius,
      transform: [{ translateX: g.x }, { translateY: g.y }],
    };
  });
  // Keep labels at their final screen position while the native clipping view
  // morphs around them. No text scaling or software mask bitmap on Android.
  const inversePosition = useAnimatedStyle(() => {
    const g = geometry.get();
    return { transform: [{ translateX: -g.x }, { translateY: -g.y }] };
  });
  const contentStyle = useAnimatedStyle(() => ({
    opacity: reduced
      ? fade.get()
      : Math.min(
          attachmentExit && open ? fade.get() : 1,
          interpolate(size.get(), [0.45, 0.9], [0, 1], "clamp"),
        ),
  }));
  const materialStyle = useAnimatedStyle(() => ({
    // Only the attachment return fades at its source before the bounded exit.
    // Standard menus preserve the original material through spring completion.
    opacity: reduced
      ? fade.get()
      : open || !attachmentExit
        ? 1
        : interpolate(size.get(), [0, 0.12], [0, 1], "clamp"),
  }));
  const dotStyle = useAnimatedStyle(() => ({
    opacity: reduced
      ? 0
      : (attachmentExit
          ? open
            ? fade.get()
            : interpolate(size.get(), [0, 0.12], [0, 1], "clamp")
          : 1) *
        interpolate(size.get(), [0, 0.25], [1, 0], "clamp"),
  }));
  const menuContents = (
    <>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, materialStyle]}
      >
        {Platform.OS === "ios" && (
          <BlurView
            intensity={70}
            tint={
              dark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"
            }
            style={blurRegion}
          />
        )}
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              // Android menus use our solid themed surface. Translucent tint
              // without a sampled backdrop lets transcript text bleed through.
              backgroundColor:
                Platform.OS === "ios"
                  ? dark
                    ? "#202020B8"
                    : "#FFFFFFB8"
                  : colors.surface,
            },
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
        <Icon name={sourceIcon} />
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
          contentContainerStyle={{ padding: 6 }}
        >
          {children}
        </ScrollView>
      </Animated.View>
    </>
  );
  return (
    <Modal
      transparent
      visible
      animationType="none"
      hardwareAccelerated
      statusBarTranslucent
      navigationBarTranslucent
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
          accessibilityLabel={dismissLabel}
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
        {Platform.OS === "android" ? (
          <Animated.View
            style={[
              { position: "absolute", top: 0, left: 0, overflow: "hidden" },
              shape,
            ]}
          >
            <Animated.View
              style={[
                { position: "absolute", top: 0, left: 0, width, height },
                inversePosition,
              ]}
            >
              {menuContents}
            </Animated.View>
          </Animated.View>
        ) : (
          <MaskedView
            androidRenderingMode="software"
            pointerEvents="box-none"
            style={blurRegion}
            maskElement={
              <View
                style={{
                  position: "absolute",
                  left: -blurLeft,
                  top: -blurTop,
                  width,
                  height,
                }}
              >
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
              </View>
            }
          >
            <View
              style={{
                position: "absolute",
                left: -blurLeft,
                top: -blurTop,
                width,
                height,
              }}
            >
              {menuContents}
            </View>
          </MaskedView>
        )}
      </View>
    </Modal>
  );
}
