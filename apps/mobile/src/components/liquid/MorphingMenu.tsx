// Native adaptation of liquid-gooey's shape morph: leading mass, following size,
// a roundness envelope, and content painted separately from the silhouette.
// https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/liquid-gooey
import MaskedView from "@react-native-masked-view/masked-view";
import { BlurView } from "expo-blur";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  measure,
  type AnimatedRef,
  useFrameCallback,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  useDerivedValue,
  useReducedMotion,
  withSequence,
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
import { useOverlayOffset } from "../../ui/measure";
import {
  DURATION,
  MENU_CORNER_MS,
  MENU_DROPLET_MS,
  MENU_LEAD,
  MENU_MASS,
  MENU_SIZE,
} from "./motion";
/** Final corner radius of a menu surface (`radius.lg`). Rows inside use `radius.md`. */
const MENU_RADIUS = 20;
/** Space between a trigger and the menu it opens. */
const MENU_GAP = 6;
/** How far a covering menu reaches past its button's edge. */
const COVER_INSET = 4;
/** A closing menu is the same liquid at 1.25× the tempo: exits are shorter than entrances. */
// It also lands instead of settling: an exit that rings around its trigger keeps
// the modal (and a copy of the trigger) on screen for half a second after the
// eye has seen it arrive.
function quicker<T extends { stiffness: number; damping: number }>(spring: T, open: boolean): T {
  return open
    ? spring
    : { ...spring, stiffness: spring.stiffness * 1.5625, damping: spring.damping * 1.25, overshootClamping: true };
}
/** liquid-gooey's cornerEase: the droplet resolves into the target corners. */
const cornerEase = Easing.bezierFn(0.3, 1.05, 0.4, 1);
const ATTACHMENT_EXIT = {
  duration: 220,
  easing: Easing.bezier(0.4, 0, 0.2, 1),
  reduceMotion: ReduceMotion.System,
};

export function MorphingMenu({
  origin: anchor,
  anchorRef,
  open,
  onClose,
  onClosed,
  children,
  placement = "below",
  sourceIcon = "ellipsis",
  dismissLabel = "Dismiss thread menu",
  preferredWidth = 272,
  closingMotion = "spring",
  point: touch,
  originRadius,
  scrim = false,
  source,
}: {
  origin: MenuOrigin;
  anchorRef?: AnimatedRef<View>;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  children: ReactNode;
  /**
   * `below`/`above`: the thread and composer menus' fixed placements. `auto`:
   * below the trigger when it fits, else above; a row origin (wider than the
   * menu) opens next to the row at the touch point, a button origin grows out of
   * the button, aligned to the side of the screen it sits on.
   */
  placement?: "above" | "below" | "auto";
  /** Drawn at the origin while the surface leaves it; null for row origins. */
  sourceIcon?: IconName | null;
  /** A custom trigger's content (a chip, a value), redrawn at the origin like `sourceIcon`. */
  source?: ReactNode;
  /** Where a long press landed, in window coordinates. */
  point?: { x: number; y: number };
  /** The trigger's own corner radius; defaults to a capsule. */
  originRadius?: number;
  /** Dim the screen behind the menu (20 %). */
  scrim?: boolean;
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
  const [visible, setVisible] = useState(true);
  const didClose = useRef(false);
  const finishDismissal = useCallback(() => {
    if (didClose.current) return;
    didClose.current = true;
    onClosed();
  }, [onClosed]);
  const finishAnimation = useCallback(() => {
    // A completed shape animation does not mean UIKit has dismissed the modal.
    // Keep it mounted until onDismiss so the next picker gets a live presenter.
    if (Platform.OS === "ios") setVisible(false);
    else finishDismissal();
  }, [finishDismissal]);
  // Triggers are measured inside the app's root view; the Modal draws from the
  // screen's top. Shift into the Modal's space (a no-op on iOS and edge to edge).
  const rootY = useOverlayOffset();
  const origin = { ...anchor, y: anchor.y + rootY };
  const point = touch && { x: touch.x, y: touch.y + rootY };
  const top = insets.top + rootY + 8;
  const bottom = height - insets.bottom - 16;
  const menuWidth = Math.min(width - 32, preferredWidth);
  const clampX = (x: number) => Math.max(16, Math.min(x, width - 16 - menuWidth));
  // A row is wider than the menu: open at the finger (or under the row when
  // opened by a tap). A button: drop from it, aligned to the edge on its side.
  const fromRow = origin.width > menuWidth;
  // A trigger becomes the menu: the surface grows out of the button, chip or
  // value and covers it, its corner on the trigger's corner (liquid-gooey's plus
  // menu, iOS pull-down menus), while the trigger's glyph or content is redrawn
  // in place and dissolves into the liquid. A long-pressed row stays visible:
  // the menu grows from under the finger.
  const hasSource = !!sourceIcon || source != null;
  const cover = !fromRow && hasSource && placement !== "above";
  const target =
    fromRow && point ? { y: point.y - 22, height: 44 } : { y: origin.y, height: origin.height };
  const autoTop = cover ? origin.y - COVER_INSET : target.y + target.height + MENU_GAP;
  const autoBottom = cover ? origin.y + origin.height + COVER_INSET : target.y - MENU_GAP;
  const roomBelow = bottom - Math.max(top, autoTop);
  const roomAbove = autoBottom - top;
  const resolved =
    placement === "above"
      ? "above"
      : placement === "below" || roomBelow >= contentHeight || roomBelow >= roomAbove
        ? "below"
        : "above";
  const anchorX = point?.x ?? origin.x + origin.width / 2;
  const menuX = fromRow
    ? clampX(anchorX - 24)
    : placement === "above"
      ? clampX(origin.x)
      : anchorX > width / 2
        ? clampX(origin.x + origin.width + (cover ? COVER_INSET : 0) - menuWidth)
        : clampX(origin.x - (cover ? COVER_INSET : 0));
  const belowY = Math.max(top, autoTop);
  const maxHeight = Math.max(
    44,
    resolved === "below" ? bottom - belowY : (placement === "above" ? origin.y - MENU_GAP : autoBottom) - top,
  );
  const menuHeight = Math.min(contentHeight, maxHeight);
  const menuY =
    resolved === "below"
      ? belowY
      : placement === "above"
        ? Math.max(top, origin.y - menuHeight - MENU_GAP)
        : Math.max(top, autoBottom - menuHeight);
  // Where the silhouette starts and ends: the trigger, or for a long-pressed
  // row a 44 pt capsule under the finger, so a menu never swells out of a
  // whole row or message.
  const seed =
    fromRow && point
      ? {
          x: Math.max(origin.x, Math.min(point.x - 22, origin.x + origin.width - 44)),
          y: point.y - 22,
          width: 44,
          height: 44,
        }
      : origin;
  const startRadius =
    seed === origin
      ? Math.min(originRadius ?? origin.width / 2, origin.width / 2, origin.height / 2)
      : 22;
  // A native modal can dismiss the keyboard underneath it. Follow the actual
  // trigger rather than keeping the screen coordinates captured before opening.
  const anchorOffset = useSharedValue({ x: 0, y: 0 });
  useFrameCallback(() => {
    if (!anchorRef) return;
    const live = measure(anchorRef);
    if (live)
      anchorOffset.set({
        x: live.pageX - anchor.x,
        y: live.pageY - anchor.y,
      });
  });
  const anchorStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: anchorOffset.get().x },
      { translateY: anchorOffset.get().y },
    ],
  }));
  const destinationHeight = useSharedValue(0);
  const measured = useRef(false);
  useEffect(() => {
    if (!menuHeight) return;
    destinationHeight.set(
      measured.current ? withSpring(menuHeight, MENU_SIZE) : menuHeight,
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
  const morph = useSharedValue(1);
  const fade = useSharedValue(0);
  const dim = useSharedValue(0);
  /** 1 while opening, 0 while closing: which way the content and material fade. */
  const opening = useSharedValue(1);
  const ready = shown && contentHeight > 0;
  const attachmentExit = closingMotion === "attachment";
  useEffect(() => {
    if (!ready) return;
    // The attachment menu needs a bounded return before opening its picker.
    // Other menus retain their original leading-mass/following-size springs.
    const boundedExit = !open && attachmentExit;
    opening.set(open ? 1 : 0);
    // The mass leaves first and carries momentum toward where it is going
    // (liquid-gooey's travel lead); the size follows on a softer spring and
    // overshoots; the corner timeline restarts with every morph.
    center.set(
      boundedExit
        ? withTiming(0, ATTACHMENT_EXIT)
        : withSpring(open ? 1 : 0, { ...quicker(MENU_MASS, open), velocity: open ? MENU_LEAD : -MENU_LEAD }),
    );
    morph.set(
      withSequence(
        withTiming(0, { duration: 0 }),
        withTiming(1, {
          duration: boundedExit ? ATTACHMENT_EXIT.duration : MENU_CORNER_MS,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.System,
        }),
      ),
    );
    size.set(
      boundedExit
        ? withTiming(0, ATTACHMENT_EXIT, (finished) => {
            if (finished && !reduced) scheduleOnRN(finishAnimation);
          })
        : withSpring(open ? 1 : 0, quicker(MENU_SIZE, open), (finished) => {
            if (finished && !open && !reduced) scheduleOnRN(finishAnimation);
          }),
    );
    dim.set(
      withTiming(open ? 1 : 0, {
        duration: DURATION.scrim,
        reduceMotion: ReduceMotion.Never,
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
          if (finished && !open && reduced) scheduleOnRN(finishAnimation);
        },
      ),
    );
  }, [
    open,
    ready,
    reduced,
    attachmentExit,
    center,
    size,
    morph,
    fade,
    dim,
    opening,
    finishAnimation,
  ]);
  const geometry = useDerivedValue(() => {
    const p = reduced ? 1 : size.get();
    const c = reduced ? 1 : center.get();
    const w = Math.max(1, seed.width + (menuWidth - seed.width) * p);
    const h = Math.max(
      1,
      seed.height + (destinationHeight.get() - seed.height) * p,
    );
    const x =
      seed.x +
      seed.width / 2 +
      (menuX + menuWidth / 2 - seed.x - seed.width / 2) * c;
    const y =
      seed.y +
      seed.height / 2 +
      (menuY + destinationHeight.get() / 2 - seed.y - seed.height / 2) * c;
    // Corners: the seed's radius on the way out, the menu's on the way in, set
    // by how far the size has travelled. On top, liquid-gooey's droplet: every
    // morph rounds the body toward a pill as it starts (a short glide, never a
    // step) and resolves back into its corners over the corner timeline.
    const t = morph.get();
    const settle = Math.max(0, Math.min(1, p));
    const base = startRadius + (MENU_RADIUS - startRadius) * settle;
    const droplet = reduced
      ? 0
      : Math.max(0, Math.min((t * MENU_CORNER_MS) / MENU_DROPLET_MS, 1 - cornerEase(t)));
    const pill = Math.min(w, h) / 2;
    const r = Math.min(pill, base + Math.max(0, pill - base) * droplet);
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
  // Content is never scaled: the liquid clips it. Opening, the labels arrive as
  // the body settles; closing, they stay until the shrinking body has closed
  // over them, so no blank surface is ever left behind.
  const contentStyle = useAnimatedStyle(() => ({
    opacity: reduced
      ? fade.get()
      : Math.min(
          attachmentExit && open ? fade.get() : 1,
          opening.get()
            ? interpolate(size.get(), [0.2, 0.6], [0, 1], "clamp")
            : interpolate(size.get(), [0.1, 0.45], [0, 1], "clamp"),
        ),
  }));
  // A trigger that stays on screen (a chip, a value, a row) shows through the
  // silhouette near its seed: the material condenses out of it on open and
  // thins back into it on close, so no blank pill covers the trigger while the
  // modal is torn down. Menus that redraw their source icon keep an opaque
  // material; the attachment return fades at its source before its picker.
  const dissolve = !hasSource;
  /** A custom trigger is redrawn at the origin (worklets can't capture the element itself). */
  const redrawn = !sourceIcon && source != null;
  const materialStyle = useAnimatedStyle(() => ({
    opacity: reduced
      ? fade.get()
      : dissolve
        ? opening.get()
          ? interpolate(size.get(), [0.05, 0.35], [0, 1], "clamp")
          : interpolate(size.get(), [0.15, 0.5], [0, 1], "clamp")
        : redrawn
          ? // A redrawn custom trigger carries its own background: the surface
            // must be gone before the body reaches the trigger's (larger) box.
            interpolate(size.get(), [0.04, 0.22], [0, 1], "clamp")
          : open || !attachmentExit
            ? 1
            : interpolate(size.get(), [0, 0.12], [0, 1], "clamp"),
  }));
  // The menu's shadow and hairline belong to the open surface; at the trigger's
  // size they would ring the redrawn trigger as a second outline.
  const outlineStyle = useAnimatedStyle(() => ({
    opacity: reduced ? 1 : interpolate(size.get(), [0.05, 0.35], [0, 1], "clamp"),
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: dim.get() }));
  const dotStyle = useAnimatedStyle(() => ({
    opacity: reduced
      ? 0
      : (attachmentExit
          ? open
            ? fade.get()
            : interpolate(size.get(), [0, 0.12], [0, 1], "clamp")
          : 1) * interpolate(size.get(), [0, 0.25], [1, 0], "clamp"),
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
      {sourceIcon && <Animated.View
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
      </Animated.View>}
      {!sourceIcon && source != null && (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: origin.x,
              top: origin.y,
              width: origin.width,
              height: origin.height,
              justifyContent: "center",
            },
            dotStyle,
          ]}
        >
          {source}
        </Animated.View>
      )}
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
      visible={visible}
      animationType="none"
      hardwareAccelerated
      statusBarTranslucent
      navigationBarTranslucent
      onShow={() => setShown(true)}
      onRequestClose={onClose}
      onDismiss={finishDismissal}
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
        >
          {scrim && (
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.scrimLight },
                scrimStyle,
              ]}
            />
          )}
        </Pressable>
        <Animated.View
          pointerEvents="box-none"
          style={[StyleSheet.absoluteFill, anchorStyle]}
        >
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, materialStyle, outlineStyle]}
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
        </Animated.View>
      </View>
    </Modal>
  );
}
