import { Busy } from "../../ui/Busy";
// Native adaptation of BeUI FileTree (MIT): https://beui.dev/r/file-tree/raw
// Retains the flattened expanded collection, indentation and selected-row model.
import { Pressable, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import type { FileEntry } from "../../state/protocol";
import { Icon, T } from "../../ui/primitives";
import { useTheme } from "../../ui/theme";
export type FlatFileTreeItem = {
  item: FileEntry;
  depth: number;
  parentId: string | null;
  position: number;
  setSize: number;
};
export function flattenItems(
  items: FileEntry[],
  expanded: ReadonlySet<string>,
  folders: Record<string, FileEntry[]>,
  depth = 0,
  parentId: string | null = null,
): FlatFileTreeItem[] {
  return items.flatMap((item, index) => {
    const row = {
      item,
      depth,
      parentId,
      position: index + 1,
      setSize: items.length,
    };
    if (
      item.kind !== "directory" ||
      !expanded.has(item.path) ||
      !folders[item.path]?.length
    )
      return [row];
    return [
      row,
      ...flattenItems(
        folders[item.path]!,
        expanded,
        folders,
        depth + 1,
        item.path,
      ),
    ];
  });
}
export function FileTreeRow({
  row,
  expanded,
  selected,
  loading,
  onPress,
}: {
  row: FlatFileTreeItem;
  expanded: boolean;
  selected: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const folder = row.item.kind === "directory";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.item.name}${folder ? ", folder" : ""}`}
      accessibilityState={{ selected, ...(folder ? { expanded } : {}) }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingVertical: 10,
        paddingRight: 12,
        paddingLeft: 12 + Math.min(row.depth, 10) * 18,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderRadius: 12,
        backgroundColor: selected
          ? colors.accentSoft
          : pressed
            ? colors.raised
            : "transparent",
      })}
    >
      {row.depth > 0 && (
        <View
          style={{
            position: "absolute",
            left: 18 + (Math.min(row.depth, 10) - 1) * 18,
            top: 0,
            bottom: 0,
            width: 1,
            backgroundColor: colors.line,
          }}
        />
      )}
      <View style={{ width: 12 }}>
        {folder && (
          <Animated.View
            style={{
              transform: [{ rotate: expanded ? "90deg" : "0deg" }],
              transitionProperty: "transform",
              transitionDuration: reduced ? 0 : 180,
            }}
          >
            <Icon name="chevron.right" size={11} color={colors.secondary} />
          </Animated.View>
        )}
      </View>
      <Icon
        name={folder ? (expanded ? "folder.fill" : "folder") : "doc.text"}
        size={19}
        color={folder ? colors.secondary : colors.muted}
      />
      <T variant="caption" numberOfLines={1} style={{ flex: 1 }}>
        {row.item.name}
      </T>
      {loading && <Busy size="small" color={colors.secondary} />}
    </Pressable>
  );
}
