// The data behind every action menu. Pure, so the grouping rules are testable and
// shared by the native iOS menus and the themed Android/fallback menu.
import type { IconName } from "./icons";

export type MenuItem = {
  title: string;
  icon?: IconName;
  /** Runs after the menu has closed, so it can navigate or open a dialog. */
  onPress?: () => void;
  /** Red text and icon. Destructive items are separated from the rest. */
  destructive?: boolean;
  /** Shows a checkmark: the current value of a choice (Status ▸ To do ✓). */
  checked?: boolean;
  disabled?: boolean;
  /** A second line, for a value or a short explanation. */
  subtitle?: string;
  /** A submenu. On iOS a native submenu; elsewhere it replaces the list in place. */
  children?: MenuItem[];
  /** Show `children` as their own section of this menu instead of a submenu. */
  inline?: boolean;
};

/**
 * Splits a menu into sections drawn with a divider between them: each `inline`
 * group is its own section, and a trailing run of destructive items is set apart.
 * Empty sections are dropped.
 */
export function menuSections(items: readonly MenuItem[]): MenuItem[][] {
  const sections: MenuItem[][] = [];
  let current: MenuItem[] = [];
  const flush = () => {
    if (current.length) sections.push(current);
    current = [];
  };
  let tail = items.length;
  while (tail > 0 && items[tail - 1]!.destructive && !items[tail - 1]!.children) tail--;
  items.forEach((item, index) => {
    if (index === tail && tail > 0) flush();
    if (item.inline && item.children) {
      flush();
      current = [...item.children];
      flush();
    } else current.push(item);
  });
  flush();
  return sections;
}

/** The items a menu shows at `path` (a list of submenu titles), or null if gone. */
export function menuAt(items: readonly MenuItem[], path: readonly string[]): MenuItem[] | null {
  let level: readonly MenuItem[] = items;
  for (const title of path) {
    const next = level
      .flatMap((item) => (item.inline && item.children ? item.children : [item]))
      .find((item) => item.title === title && item.children);
    if (!next?.children) return null;
    level = next.children;
  }
  return [...level];
}
