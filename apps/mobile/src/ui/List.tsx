// Lists: one row anatomy for every list in the app (design-system.md §Lists).
//
// ┌ InsetGroup (surface, radius md) ─────────────────────────────────────────┐
// │ 16 [lead 28] 12 [Title 17 ink ……………] 8 [meta 15 muted] [›|✓|value ⌄] 16 │ ≥ 44
// │                 [Subtitle 15 secondary, 1–2 lines]                         │
// │                 └ hairline starts at the title edge (56, or 16) ──────────│
// └───────────────────────────────────────────────────────────────────────────┘
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { COMMIT, CSS_EASE_OUT, DURATION } from "../components/liquid/motion";
import { ContextMenu, MenuButton } from "./ActionMenu";
import { haptics } from "./haptics";
import type { MenuItem } from "./menuModel";
import { Icon, T, Tap, type IconName } from "./primitives";
import { MONO, radius, space, useTheme } from "./theme";

const LEAD = 28;
/** A command as a row title: body size in MONO, a step smaller so it lines up optically. */
const MONO_TITLE = { fontFamily: MONO, fontSize: 15, letterSpacing: 0 } as const;
/** A disclosure chevron: 0° closed, 90° open, turning in 180 ms. */
const chevronTurn = (open?: boolean) => ({
  transform: [{ rotate: open ? "90deg" : "0deg" }],
  transitionProperty: "transform" as const,
  transitionDuration: DURATION.state,
  transitionTimingFunction: CSS_EASE_OUT,
});
/** Where the separator starts: the title's leading edge. */
export const rowInset = (leading: boolean) =>
  leading ? space.lg + LEAD + space.md : space.lg;

type Position = { last: boolean; inGroup: boolean };
const RowPosition = createContext<Position>({ last: true, inGroup: false });
/** The surface plain rows sit on, when it isn't `background` (the iPad sidebar's material). */
const RowSurface = createContext<string | null>(null);

/**
 * Plain rows inside draw on `color` instead of `background`: pass "transparent"
 * over a material. `lift` is the opaque colour the iOS long-press preview uses.
 */
export function ListSurface({ color, lift, children }: PropsWithChildren<{ color: string; lift?: string }>) {
  return <RowSurface.Provider value={lift ? `${color}|${lift}` : color}>{children}</RowSurface.Provider>;
}

/** A rounded group of rows on a `surface`, separated from its neighbours by surface, not margin. */
export function InsetGroup({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const { colors } = useTheme();
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.md,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {rows.map((row, index) => (
        <RowPosition.Provider
          key={row.key ?? index}
          value={{ last: index === rows.length - 1, inGroup: true }}
        >
          {row}
        </RowPosition.Provider>
      ))}
    </View>
  );
}

/** Separator for plain lists (`ItemSeparatorComponent`). Inset to the title edge. */
export function ListSeparator({ leading = false }: { leading?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        marginStart: rowInset(leading),
        backgroundColor: colors.line,
      }}
    />
  );
}

/**
 * Sentence-case label over a group: optional count and one trailing text
 * action ("New", "See all"). Collapsible headers put a rotating chevron after
 * the label and make the whole header the target.
 */
export function SectionHeader({
  title,
  count,
  action,
  open,
  onToggle,
  inset = false,
  first = false,
}: {
  title: string;
  count?: number;
  action?: { title: string; onPress: () => void; label?: string };
  open?: boolean;
  onToggle?: () => void;
  /** Align with rows inside an InsetGroup (adds the row's 16 pt). */
  inset?: boolean;
  /** No top padding (first section under the header). */
  first?: boolean;
}) {
  const { colors } = useTheme();
  const label = (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexShrink: 1 }}>
      <T variant="sectionHeader" tone="secondary" accessibilityRole="header" numberOfLines={1}>
        {title}
      </T>
      {count != null ? (
        <T variant="footnote" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
          {count}
        </T>
      ) : null}
      {onToggle ? (
        <Animated.View style={[{ alignSelf: "center" }, chevronTurn(open)]}>
          <Icon name="chevron.right" size={11} color={colors.muted} />
        </Animated.View>
      ) : null}
    </View>
  );
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: space.md,
        paddingTop: first ? space.sm : 28,
        paddingBottom: space.sm,
        paddingHorizontal: inset ? space.lg : 0,
      }}
    >
      {onToggle ? (
        <Tap
          label={`${title}, ${open ? "expanded" : "collapsed"}`}
          expanded={open}
          feedback="none"
          onPress={onToggle}
          style={{ flexDirection: "row", alignItems: "flex-end", minHeight: 0, flexShrink: 1 }}
        >
          {label}
        </Tap>
      ) : (
        label
      )}
      {action ? (
        <Tap
          label={action.label ?? action.title}
          onPress={action.onPress}
          feedback="none"
          hitSlop={12}
          style={{ minHeight: 0, minWidth: 0, flexDirection: "row" }}
        >
          <T variant="subhead" tone="accent">
            {action.title}
          </T>
        </Tap>
      ) : null}
    </View>
  );
}

/** Explanation under a group ("Deleted notes are removed after 30 days."). */
export function SectionFooter({ children, inset = false }: { children: string; inset?: boolean }) {
  return (
    <T
      variant="footnote"
      tone="muted"
      style={{ paddingTop: space.sm, paddingHorizontal: inset ? space.lg : 0 }}
    >
      {children}
    </T>
  );
}

export type SwipeAction = {
  title: string;
  icon: IconName;
  /** accent: pin · positive: done · negative: delete · neutral: archive. */
  tone: "accent" | "positive" | "negative" | "neutral";
  onPress: () => void;
  /** A full swipe (past 60 % of the row) commits this action; the outermost one only. */
  full?: boolean;
};

const ACTION_WIDTH = 74;

function SwipeActions({
  actions,
  side,
  translation,
  width,
  armed,
  close,
}: {
  actions: readonly SwipeAction[];
  side: "leading" | "trailing";
  translation: SharedValue<number>;
  width: number;
  armed: SharedValue<boolean>;
  close: () => void;
}) {
  const { colors } = useTheme();
  const fill = (tone: SwipeAction["tone"]) =>
    tone === "neutral" ? "#8E8E93" : colors[tone];
  const outer = side === "trailing" ? actions[actions.length - 1] : actions[0];
  const full = outer?.full && width > 0;
  useAnimatedReaction(
    () => full && Math.abs(translation.get()) > width * 0.6,
    (now, before) => {
      if (now === before) return;
      armed.set(!!now);
      if (now) scheduleOnRN(haptics.threshold);
    },
  );
  // The outermost action's colour fills everything the row uncovers, so an
  // overswipe reads as one surface (Mail). Crossing the threshold lifts its icon.
  const lift = useAnimatedStyle(() => ({
    transform: [
      { scale: withTiming(full && armed.get() ? 1.15 : 1, { duration: DURATION.press }) },
    ],
  }));
  return (
    <View style={{ flexDirection: "row", alignSelf: "stretch" }}>
      {outer && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: Math.max(width, ACTION_WIDTH * actions.length),
            ...(side === "trailing" ? { end: 0 } : { start: 0 }),
            backgroundColor: fill(outer.tone),
          }}
        />
      )}
      {actions.map((action) => (
        <View key={action.title} style={{ width: ACTION_WIDTH, alignSelf: "stretch" }}>
          <Tap
            label={action.title}
            feedback="none"
            onPress={() => {
              close();
              action.onPress();
            }}
            style={{
              flex: 1,
              alignItems: "center",
              gap: space.xs,
              backgroundColor: fill(action.tone),
            }}
          >
            <Animated.View style={action === outer ? lift : undefined}>
              <Icon name={action.icon} size={20} color="#FFFFFF" />
            </Animated.View>
            <T variant="caption" style={{ color: "#FFFFFF" }} numberOfLines={1}>
              {action.title}
            </T>
          </Tap>
        </View>
      ))}
    </View>
  );
}

/**
 * Swipe actions on a row (gesture-handler's ReanimatedSwipeable). Release
 * velocity carries into the settle spring; Reduce Motion still reveals the
 * actions but without the rubber band.
 */
export function Swipeable({
  leading,
  trailing,
  children,
  background,
}: PropsWithChildren<{
  leading?: readonly SwipeAction[];
  trailing?: readonly SwipeAction[];
  background: string;
}>) {
  const ref = useRef<SwipeableMethods>(null);
  const [width, setWidth] = useState(0);
  const armed = useSharedValue(false);
  const close = () => ref.current?.close();
  const commit = (side: "leading" | "trailing") => {
    if (!armed.get()) return;
    armed.set(false);
    const list = side === "leading" ? leading : trailing;
    const action = side === "leading" ? list?.[0] : list?.[list.length - 1];
    if (!action?.full) return;
    haptics.commit();
    close();
    action.onPress();
  };
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <ReanimatedSwipeable
        ref={ref}
        friction={1}
        overshootFriction={1}
        leftThreshold={ACTION_WIDTH / 2}
        rightThreshold={ACTION_WIDTH / 2}
        overshootLeft={!!leading?.[0]?.full}
        overshootRight={!!trailing?.[trailing.length - 1]?.full}
        animationOptions={COMMIT}
        childrenContainerStyle={{ backgroundColor: background }}
        onSwipeableWillOpen={(direction) =>
          // RNGH names the side the panel is dragged toward.
          commit(direction === "left" ? "trailing" : "leading")
        }
        renderLeftActions={
          leading?.length
            ? (_p, translation) => (
                <SwipeActions
                  actions={leading}
                  side="leading"
                  translation={translation}
                  width={width}
                  armed={armed}
                  close={close}
                />
              )
            : undefined
        }
        renderRightActions={
          trailing?.length
            ? (_p, translation) => (
                <SwipeActions
                  actions={trailing}
                  side="trailing"
                  translation={translation}
                  width={width}
                  armed={armed}
                  close={close}
                />
              )
            : undefined
        }
      >
        {children}
      </ReanimatedSwipeable>
    </View>
  );
}

export type ListRowProps = {
  title: string;
  subtitle?: string;
  subtitleLines?: number;
  /** "middle" for paths: ~/projects/…/mobile. */
  subtitleEllipsize?: "tail" | "middle";
  titleLines?: number;
  /** Machine text (a command, a path): the title in MONO. */
  mono?: boolean;
  /** An icon (20 pt, `secondary`) or any 28 pt node: a status glyph, provider mark, project dot. */
  leading?: IconName | ReactNode;
  /** Trailing time or count, `muted`, tabular. */
  meta?: string;
  /** Trailing current value. With `valueMenu` it opens that menu (⌄). */
  value?: string;
  valueMenu?: readonly MenuItem[];
  /** A trailing checkmark: this row is the chosen option. */
  checked?: boolean;
  /** A push row: trailing chevron. */
  chevron?: boolean;
  /** Any trailing control (a Toggle). */
  trailing?: ReactNode;
  /** Selected in a sidebar or rail: `accentSoft` fill. */
  selected?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  /** Accessible name when the title alone says too little. */
  label?: string;
  /** Long-press actions (iOS native context menu, Android themed menu). */
  menu?: readonly MenuItem[];
  menuTitle?: string;
  swipe?: { leading?: readonly SwipeAction[]; trailing?: readonly SwipeAction[] };
  /** Draw the inset hairline under this row in a plain list. InsetGroup does this itself. */
  separator?: boolean;
};

/** The one list row. See the anatomy at the top of this file. */
export function ListRow(props: ListRowProps) {
  const {
    title,
    subtitle,
    subtitleLines = 2,
    subtitleEllipsize = "tail",
    titleLines = 1,
    mono,
    leading,
    meta,
    value,
    valueMenu,
    checked,
    chevron,
    trailing,
    selected,
    destructive,
    disabled,
    onPress,
    label,
    menu,
    menuTitle,
    swipe,
    separator,
  } = props;
  const { colors } = useTheme();
  const position = useContext(RowPosition);
  const [surface, lift] = (useContext(RowSurface) ?? "").split("|");
  const background = selected
    ? colors.accentSoft
    : position.inGroup
      ? colors.surface
      : surface || colors.background;
  const hasLeading = leading != null && leading !== false;
  const showSeparator = position.inGroup ? !position.last : !!separator;
  const lead = hasLeading ? (
    <View style={{ width: LEAD, alignItems: "center", justifyContent: "center", alignSelf: subtitle ? "flex-start" : "center", paddingTop: subtitle ? 1 : 0 }}>
      {typeof leading === "string" ? (
        <Icon
          name={leading as IconName}
          size={20}
          color={destructive ? colors.negative : selected ? colors.accent : colors.secondary}
        />
      ) : (
        leading
      )}
    </View>
  ) : null;
  const valueText = value ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 1, maxWidth: "55%" }}>
      <T variant="body" tone="secondary" numberOfLines={1}>
        {value}
      </T>
      {valueMenu ? (
        <Icon name="chevron.up.chevron.down" size={13} color={colors.muted} />
      ) : null}
    </View>
  ) : null;
  const end =
    trailing ??
    (checked ? (
      <Icon name="checkmark" size={17} color={colors.accent} />
    ) : chevron ? (
      <Icon name="chevron.right" size={12} color={colors.muted} />
    ) : null);
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: 44,
        paddingVertical: subtitle ? 10 : 11,
        paddingHorizontal: space.lg,
      }}
    >
      {lead}
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          <T
            variant="body"
            tone={destructive ? "negative" : selected ? "accent" : "ink"}
            numberOfLines={titleLines}
            style={[{ flex: 1 }, selected ? { fontWeight: "600" } : null, mono ? MONO_TITLE : null]}
          >
            {title}
          </T>
          {meta ? (
            <T variant="subhead" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
              {meta}
            </T>
          ) : null}
        </View>
        {subtitle ? (
          <T variant="subhead" tone="secondary" numberOfLines={subtitleLines} ellipsizeMode={subtitleEllipsize}>
            {subtitle}
          </T>
        ) : null}
      </View>
      {valueText}
      {end}
    </View>
  );
  const hairline = showSeparator ? (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        bottom: 0,
        end: 0,
        start: rowInset(hasLeading),
        height: StyleSheet.hairlineWidth,
        backgroundColor: colors.line,
      }}
    />
  ) : null;
  const a11y = label ?? [title, subtitle, value, meta, checked ? "selected" : ""].filter(Boolean).join(", ");
  let row: ReactNode;
  if (valueMenu) {
    row = (
      <MenuButton items={valueMenu} title={title} label={a11y} disabled={disabled} radius={0} style={{ backgroundColor: background }}>
        {body}
      </MenuButton>
    );
  } else if (menu?.length) {
    row = (
      <ContextMenu items={menu} title={menuTitle ?? title} surface={lift || background} radius={position.inGroup ? radius.md : 0}>
        {({ onLongPress }) => (
          <Tap
            label={a11y}
            selected={checked || selected}
            disabled={disabled}
            feedback="highlight"
            onPress={onPress}
            onLongPress={onLongPress}
            style={{ backgroundColor: background }}
          >
            {body}
          </Tap>
        )}
      </ContextMenu>
    );
  } else if (onPress) {
    row = (
      <Tap
        label={a11y}
        selected={checked || selected}
        disabled={disabled}
        feedback="highlight"
        onPress={onPress}
        style={{ backgroundColor: background }}
      >
        {body}
      </Tap>
    );
  } else {
    row = (
      <View accessible accessibilityLabel={a11y} style={{ backgroundColor: background }}>
        {body}
      </View>
    );
  }
  if (swipe && (swipe.leading?.length || swipe.trailing?.length))
    row = (
      <Swipeable leading={swipe.leading} trailing={swipe.trailing} background={background}>
        {row}
      </Swipeable>
    );
  return (
    <View>
      {row}
      {hairline}
    </View>
  );
}

/** A disclosure inside a list ("Thread notes 3 ›"), aligned to the row text edge. */
export function DisclosureRow({
  title,
  count,
  open,
  onToggle,
  indent = 0,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  indent?: number;
}) {
  const { colors } = useTheme();
  return (
    <Tap
      label={`${title}${count != null ? `, ${count}` : ""}, ${open ? "expanded" : "collapsed"}`}
      expanded={open}
      feedback="highlight"
      onPress={onToggle}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingStart: space.lg + indent,
        paddingEnd: space.lg,
      }}
    >
      <T variant="subhead" tone="secondary">
        {title}
      </T>
      {count != null ? (
        <T variant="subhead" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
          {count}
        </T>
      ) : null}
      <Animated.View style={chevronTurn(open)}>
        <Icon name="chevron.right" size={11} color={colors.muted} />
      </Animated.View>
    </Tap>
  );
}
