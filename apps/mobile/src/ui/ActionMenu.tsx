// Action menus: one item model (menuModel.ts), three triggers.
//
//   ContextMenu   long-press on a row. iOS: the native UIContextMenu (the row lifts,
//                 system blur, haptic). Android: the themed MorphingMenu growing out
//                 of the row at the touch point.
//   MenuButton    tap a button or a value ("…", "Medium ⌄"). The themed MorphingMenu
//                 on both platforms (iOS draws it over system chrome blur): UIKit's
//                 tap-to-open menus need a bar button or a native dependency.
//   HeaderActions the header's trailing buttons and "…". iOS: native bar buttons and
//                 a native pull-down menu. Android: themed buttons + MorphingMenu.
//
// Item actions run after the menu has finished closing, so they can navigate or
// open a confirmation without fighting the menu's own dismissal.
import { Stack } from "expo-router";
import {
  NativeLinkPreview,
  NativeLinkPreviewAction,
} from "expo-router/build/link/preview/native";
import {
  Fragment,
  useCallback,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Platform,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { MorphingMenu, type MenuOrigin } from "../components/liquid/MorphingMenu";
import { DURATION } from "../components/liquid/motion";
import { haptics } from "./haptics";
import { measureTrigger } from "./measure";
import { menuAt, menuSections, type MenuItem } from "./menuModel";
import {
  Button,
  Icon,
  IconButton,
  T,
  Tap,
  type IconName,
} from "./primitives";
import { radius, space, useTheme } from "./theme";

export type { MenuItem } from "./menuModel";

/** iOS UIContextMenu / UIMenu actions for an item tree. */
function nativeActions(items: readonly MenuItem[], prefix: string): ReactNode[] {
  return menuSections(items).map((section, s) => {
    const actions = section.map((item, i) => {
      const id = `${prefix}.${s}.${i}`;
      return (
        <NativeLinkPreviewAction
          key={id}
          identifier={id}
          title={item.title}
          icon={item.nativeIcon ?? item.icon}
          subtitle={item.subtitle}
          destructive={item.destructive}
          disabled={item.disabled}
          isOn={item.checked}
          onSelected={() => item.onPress?.()}
        >
          {item.children ? nativeActions(item.children, id) : undefined}
        </NativeLinkPreviewAction>
      );
    });
    // UIMenu draws separators between inline groups.
    return (
      <NativeLinkPreviewAction
        key={`${prefix}.${s}`}
        identifier={`${prefix}.${s}`}
        title=""
        displayInline
        onSelected={() => {}}
      >
        {actions}
      </NativeLinkPreviewAction>
    );
  });
}

/** One row of the themed menu. 48 pt, 20 pt icon, concentric 14 pt highlight. */
function MenuRow({
  item,
  leading,
  onSelect,
}: {
  item: MenuItem;
  leading: boolean;
  onSelect: (item: MenuItem) => void;
}) {
  const { colors } = useTheme();
  const tint = item.destructive ? colors.negative : colors.secondary;
  return (
    <Tap
      label={item.title}
      hint={item.children ? "Opens a submenu" : undefined}
      selected={item.checked}
      disabled={item.disabled}
      feedback="highlight"
      onPress={() => onSelect(item)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: 48,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
      }}
    >
      {leading && (
        <View style={{ width: 20, alignItems: "center" }}>
          {item.leading ?? (item.icon && <Icon name={item.icon} size={20} color={tint} />)}
        </View>
      )}
      <View style={{ flex: 1, paddingVertical: space.sm }}>
        <T
          variant="subhead"
          tone={item.destructive ? "negative" : "ink"}
          numberOfLines={2}
        >
          {item.title}
        </T>
        {item.subtitle ? (
          <T variant="footnote" tone="secondary" numberOfLines={2}>
            {item.subtitle}
          </T>
        ) : null}
      </View>
      {item.checked ? (
        <Icon name="checkmark" size={17} color={colors.accent} />
      ) : item.children ? (
        <Icon name="chevron.right" size={12} color={colors.muted} />
      ) : null}
    </Tap>
  );
}

/**
 * The themed menu's content: an optional title naming the object, sections with
 * hairline dividers, and submenus that replace the list in place (the surface
 * morphs to the new height) behind a "‹ Status" back row.
 */
export function MenuPanel({
  items,
  title,
  onSelect,
}: {
  items: readonly MenuItem[];
  title?: string;
  onSelect: (item: MenuItem) => void;
}) {
  const { colors } = useTheme();
  const [path, setPath] = useState<string[]>([]);
  // The first list arrives with the surface's own morph; only a submenu swap
  // cross-fades (a layout animation on the first mount would also run inside
  // Android's modal window while the silhouette is still growing).
  const [navigated, setNavigated] = useState(false);
  const go = (next: string[]) => {
    setNavigated(true);
    setPath(next);
  };
  const level = menuAt(items, path) ?? [...items];
  const sections = menuSections(level);
  const leading = level.some(
    (item) => item.icon || item.leading || item.children?.some((child) => child.icon || child.leading),
  );
  const heading = path.length ? path[path.length - 1] : title;
  return (
    <Animated.View key={path.join("/")} entering={navigated ? FadeIn.duration(DURATION.scrim) : undefined}>
      {path.length ? (
        <Tap
          label={`Back to ${path.length > 1 ? path[path.length - 2] : (title ?? "menu")}`}
          feedback="highlight"
          onPress={() => go(path.slice(0, -1))}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            minHeight: 44,
            paddingHorizontal: space.md,
            borderRadius: radius.md,
          }}
        >
          <Icon name="chevron.left" size={14} color={colors.secondary} />
          <T variant="sectionHeader" tone="secondary" numberOfLines={1}>
            {heading}
          </T>
        </Tap>
      ) : heading ? (
        <T
          variant="footnote"
          tone="secondary"
          numberOfLines={2}
          accessibilityRole="header"
          style={{ paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.xs }}
        >
          {heading}
        </T>
      ) : null}
      {sections.map((section, index) => (
        <Fragment key={index}>
          {index > 0 || heading ? (
            <View
              style={{
                height: 0.5,
                backgroundColor: colors.line,
                marginVertical: space.xs,
                marginHorizontal: -6,
              }}
            />
          ) : null}
          {section.map((item, row) => (
            <MenuRow
              // Titles can repeat (two computers with one name); the position keeps rows apart.
              key={`${row}:${item.title}`}
              item={item}
              leading={leading}
              onSelect={(picked) => {
                if (picked.children) go([...path, picked.title]);
                else onSelect(picked);
              }}
            />
          ))}
        </Fragment>
      ))}
    </Animated.View>
  );
}

type SurfaceRequest = {
  items: readonly MenuItem[];
  title?: string;
  origin: MenuOrigin;
  point?: { x: number; y: number };
  sourceIcon?: IconName | null;
  /** A custom trigger's content, redrawn at the origin while the menu grows out of it. */
  source?: ReactNode;
  originRadius?: number;
};

/**
 * Opens the themed menu from code: `show()` with the trigger's window rect.
 * Render `element` anywhere in the tree.
 */
export function useMenuSurface() {
  const [request, setRequest] = useState<SurfaceRequest | null>(null);
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | undefined>(undefined);
  const show = useCallback((next: SurfaceRequest) => {
    pending.current = undefined;
    setRequest(next);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const closed = useCallback(() => {
    setRequest(null);
    const action = pending.current;
    pending.current = undefined;
    action?.();
  }, []);
  const element = request ? (
    <MorphingMenu
      origin={request.origin}
      point={request.point}
      placement="auto"
      sourceIcon={request.sourceIcon ?? null}
      source={request.source}
      originRadius={request.originRadius}
      dismissLabel="Close menu"
      scrim
      open={open}
      onClose={close}
      onClosed={closed}
    >
      <MenuPanel
        items={request.items}
        title={request.title}
        onSelect={(item) => {
          pending.current = item.onPress;
          close();
        }}
      />
    </MorphingMenu>
  ) : null;
  return { show, close, element };
}

/**
 * Long-press menu on a row. The child render function receives `onLongPress`
 * (undefined on iOS, where the native menu owns the gesture) and `open`, which
 * shows the same items as a themed menu from a tap (a deleted note's row).
 * `surface` is the row's background, used by the iOS lift preview.
 */
export function ContextMenu({
  items,
  title,
  surface,
  radius: rowRadius = 0,
  style,
  children,
}: {
  items: readonly MenuItem[];
  /** Names the object at the top of the themed menu ("Project brief"). */
  title?: string;
  surface?: string;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  children: (bind: {
    onLongPress?: (event: GestureResponderEvent) => void;
    open: (event?: GestureResponderEvent) => void;
  }) => ReactElement;
}) {
  const { colors } = useTheme();
  const anchor = useRef<View>(null);
  const prefix = useId();
  const menu = useMenuSurface();
  const background = surface ?? colors.background;
  const open = (event?: GestureResponderEvent) => {
    if (!items.length) return;
    const point = event
      ? { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }
      : undefined;
    measureTrigger(anchor.current, (origin) =>
      menu.show({ items, title, origin, point, originRadius: rowRadius }),
    );
  };
  // No `display: contents` on the native view (expo-router's own Link uses it):
  // it hides the whole row from VoiceOver.
  if (Platform.OS === "ios")
    return (
      <>
        <NativeLinkPreview
          nextScreenId={undefined}
          tabPath={undefined}
        >
          <View
            ref={anchor}
            collapsable={false}
            style={[{ backgroundColor: background, borderRadius: rowRadius }, style]}
          >
            {children({ open })}
          </View>
          {items.length ? nativeActions(items, prefix) : null}
        </NativeLinkPreview>
        {menu.element}
      </>
    );
  return (
    <>
      <View ref={anchor} collapsable={false} style={style}>
        {children({
          open,
          onLongPress: (event) => {
            haptics.menu();
            open(event);
          },
        })}
      </View>
      {menu.element}
    </>
  );
}

/**
 * A tap-to-open menu. Default trigger is a 44 pt "…" icon button; pass
 * `children` to use your own trigger content (a value with ⌄, a text button).
 */
export function MenuButton({
  items,
  title,
  label,
  icon = "ellipsis",
  children,
  style,
  disabled,
  radius: triggerRadius = radius.sm,
}: {
  items: readonly MenuItem[];
  title?: string;
  /** Accessible name of the trigger ("Note options"). */
  label: string;
  /** Corner radius of a custom trigger's highlight (0 for a full-width row). */
  radius?: number;
  icon?: IconName;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
}) {
  const anchor = useRef<View>(null);
  const menu = useMenuSurface();
  // The trigger grows into the menu and back, whether it is an icon button or
  // custom content (a value, a chip).
  const open = () =>
    measureTrigger(anchor.current, (origin) =>
      menu.show({
        items,
        title,
        origin,
        originRadius: children ? triggerRadius : undefined,
        // The trigger turns into the menu: an icon button's glyph, or a custom
        // trigger's own content, is redrawn where it sits while the surface grows
        // out of it and back.
        sourceIcon: children ? null : icon,
        source: children,
      }),
    );
  return (
    <>
      <View ref={anchor} collapsable={false} style={style}>
        {children ? (
          <Tap label={label} hint="Opens a menu" onPress={open} disabled={disabled} feedback="highlight" style={{ borderRadius: triggerRadius }}>
            {children}
          </Tap>
        ) : (
          <IconButton name={icon} label={label} onPress={open} disabled={disabled} />
        )}
      </View>
      {menu.element}
    </>
  );
}

export type HeaderButton = {
  /** Visible text ("Edit"); icon-only buttons need `label`. */
  title?: string;
  icon?: IconName;
  label?: string;
  onPress: () => void;
  /** The screen's commit ("Done"): iOS prominent bar button, Android tinted. */
  prominent?: boolean;
  disabled?: boolean;
};

function toolbarItems(items: readonly MenuItem[]): ReactNode[] {
  return menuSections(items).map((section, s) => (
    <Stack.Toolbar.Menu key={s} inline title="">
      {section.map((item) =>
        item.children ? (
          <Stack.Toolbar.Menu
            key={item.title}
            title={item.title}
            icon={item.icon}
            disabled={item.disabled}
          >
            {toolbarItems(item.children)}
          </Stack.Toolbar.Menu>
        ) : (
          <Stack.Toolbar.MenuAction
            key={item.title}
            icon={item.nativeIcon ?? item.icon}
            subtitle={item.subtitle}
            destructive={item.destructive}
            disabled={item.disabled}
            isOn={item.checked}
            onPress={item.onPress}
          >
            {item.title}
          </Stack.Toolbar.MenuAction>
        ),
      )}
    </Stack.Toolbar.Menu>
  ));
}

/**
 * The header's trailing controls. Render it inside the screen (it configures
 * the screen's header). iOS: native bar buttons (system glass) and a native
 * pull-down "…" menu. Android: plain text/icon buttons and the themed menu.
 */
export function HeaderActions({
  buttons = [],
  menu,
}: {
  buttons?: readonly HeaderButton[];
  menu?: { label: string; items: readonly MenuItem[]; title?: string };
}) {
  if (Platform.OS === "ios")
    return (
      <Stack.Toolbar placement="right">
        {buttons.map((button, index) => (
          <Stack.Toolbar.Button
            key={button.title ?? button.label ?? index}
            icon={button.icon}
            accessibilityLabel={button.label ?? button.title}
            variant={button.prominent ? "prominent" : "plain"}
            disabled={button.disabled}
            onPress={button.onPress}
          >
            {button.icon ? undefined : button.title}
          </Stack.Toolbar.Button>
        ))}
        {menu && (
          <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={menu.label} title={menu.title}>
            {toolbarItems(menu.items)}
          </Stack.Toolbar.Menu>
        )}
      </Stack.Toolbar>
    );
  return (
    <Stack.Screen
      options={{
        headerRight: () => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            {buttons.map((button, index) =>
              button.icon ? (
                <IconButton
                  key={button.label ?? index}
                  name={button.icon}
                  label={button.label ?? button.title ?? ""}
                  disabled={button.disabled}
                  onPress={button.onPress}
                />
              ) : (
                <Button
                  key={button.title ?? index}
                  role={button.prominent ? "tinted" : "plain"}
                  size="medium"
                  disabled={button.disabled}
                  onPress={button.onPress}
                >
                  {button.title}
                </Button>
              ),
            )}
            {menu && (
              <MenuButton label={menu.label} title={menu.title} items={menu.items} />
            )}
          </View>
        ),
      }}
    />
  );
}
