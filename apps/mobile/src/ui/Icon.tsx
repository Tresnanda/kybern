// One icon vocabulary: SF Symbols on iOS, Material Symbols on Android, so the
// same name renders a native glyph on both.

import React from "react";
import { SymbolView, type SymbolWeight } from "expo-symbols";
import type { SFSymbol } from "sf-symbols-typescript";
import type { AndroidSymbol } from "expo-symbols";
import { useTheme } from "./theme";

export const ICONS = {
  threads: { ios: "bubble.left.and.bubble.right", android: "forum" },
  threadsFill: { ios: "bubble.left.and.bubble.right.fill", android: "forum" },
  approvals: { ios: "checkmark.shield", android: "verified_user" },
  approvalsFill: { ios: "checkmark.shield.fill", android: "verified_user" },
  settings: { ios: "gearshape", android: "settings" },
  settingsFill: { ios: "gearshape.fill", android: "settings" },
  compose: { ios: "square.and.pencil", android: "edit_square" },
  plus: { ios: "plus", android: "add" },
  send: { ios: "arrow.up", android: "arrow_upward" },
  stop: { ios: "stop.fill", android: "stop" },
  pin: { ios: "pin", android: "push_pin" },
  pinFill: { ios: "pin.fill", android: "push_pin" },
  unpin: { ios: "pin.slash", android: "push_pin" },
  archive: { ios: "archivebox", android: "archive" },
  chevronRight: { ios: "chevron.right", android: "chevron_right" },
  chevronDown: { ios: "chevron.down", android: "expand_more" },
  copy: { ios: "doc.on.doc", android: "content_copy" },
  folder: { ios: "folder", android: "folder" },
  bolt: { ios: "bolt.fill", android: "bolt" },
  shield: { ios: "shield", android: "shield" },
  terminal: { ios: "terminal", android: "terminal" },
  check: { ios: "checkmark", android: "check" },
  close: { ios: "xmark", android: "close" },
  more: { ios: "ellipsis", android: "more_horiz" },
  link: { ios: "link", android: "link" },
  signal: { ios: "dot.radiowaves.left.and.right", android: "sensors" },
  branch: { ios: "arrow.triangle.branch", android: "account_tree" },
  clock: { ios: "clock", android: "schedule" },
  sparkles: { ios: "sparkles", android: "auto_awesome" },
  search: { ios: "magnifyingglass", android: "search" },
  inbox: { ios: "tray", android: "inbox" },
  phone: { ios: "iphone", android: "smartphone" },
  computer: { ios: "desktopcomputer", android: "computer" },
  refresh: { ios: "arrow.clockwise", android: "refresh" },
  logout: { ios: "rectangle.portrait.and.arrow.right", android: "logout" },
  json: { ios: "curlybraces", android: "data_object" },
} satisfies Record<string, { ios: SFSymbol; android: AndroidSymbol }>;

export type IconName = keyof typeof ICONS;

interface Props {
  name: IconName;
  size?: number;
  color?: string;
  weight?: SymbolWeight;
}

export function Icon({ name, size = 20, color, weight = "medium" }: Props) {
  const th = useTheme();
  const spec = ICONS[name];
  return (
    <SymbolView
      name={{ ios: spec.ios, android: spec.android }}
      size={size}
      tintColor={color ?? th.text}
      weight={weight}
      resizeMode="scaleAspectFit"
      style={{ width: size, height: size }}
    />
  );
}
