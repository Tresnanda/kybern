// Spaces in the lists: the switcher chip (Threads, sidebar, Projects) and the
// menu items that switch, create and manage spaces. Switching changes what the
// lists show and nothing animates.
import { router } from "expo-router";
import { View } from "react-native";
import { count } from "../state/format";
import {
  currentSpaceId,
  setCurrentSpace,
  SPACE_COPY,
  useSpaces,
} from "../state/spaces";
import { useProjects } from "../state/runtime";
import { MenuButton } from "../ui/ActionMenu";
import type { MenuItem } from "../ui/menuModel";
import { Icon, T } from "../ui/primitives";
import { SpaceTile } from "../ui/SpaceTile";
import { radius, space, useTheme } from "../ui/theme";

/** "Personal ✓ / Work / New space… / Manage spaces…" as one inline menu section, or nothing without spaces. */
export function useSpaceMenuItems(): MenuItem[] {
  const s = useSpaces();
  const projects = useProjects();
  if (s.supported !== true) return [];
  const active = currentSpaceId(s);
  const projectCount = (id: string) => projects.filter((p) => p.space_id === id).length;
  return [
    {
      title: "Spaces",
      inline: true,
      children: [
        ...(s.spaces.length > 1
          ? s.spaces.map<MenuItem>((space) => ({
              title: space.name,
              subtitle: count(projectCount(space.id), "project"),
              checked: space.id === active,
              onPress: () => setCurrentSpace(space.id),
            }))
          : []),
        { title: SPACE_COPY.newSpaceMenu, icon: "plus", onPress: () => router.push("/space-edit") },
        { title: "Manage spaces…", icon: "square.stack.3d.up", onPress: () => router.push("/spaces") },
      ],
    },
  ];
}

/**
 * The active space as a chip that opens the switcher. Shown only with two or more
 * spaces: with one, there is nothing to switch to.
 */
export function SpaceSwitcher({ compact = false }: { compact?: boolean }) {
  const { colors } = useTheme();
  const s = useSpaces();
  const items = useSpaceMenuItems();
  const active = s.spaces.find((space) => space.id === currentSpaceId(s));
  if (!active || s.spaces.length < 2) return null;
  return (
    <MenuButton items={items} title="Space" label={`Space: ${active.name}. Switch space`} radius={radius.full}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          minHeight: compact ? 32 : 36,
          paddingStart: space.xs + 2,
          paddingEnd: space.md,
          borderRadius: radius.full,
          backgroundColor: colors.raised,
        }}
      >
        <SpaceTile space={active} size={compact ? 20 : 22} />
        <T variant="subhead" numberOfLines={1} style={{ fontWeight: "600", flexShrink: 1 }}>
          {active.name}
        </T>
        <Icon name="chevron.up.chevron.down" size={12} color={colors.muted} />
      </View>
    </MenuButton>
  );
}
