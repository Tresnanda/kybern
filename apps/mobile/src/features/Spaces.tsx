// Spaces in the lists: the switcher chip (Threads, sidebar, Projects) and the
// menu items that switch, create and manage spaces. Switching changes what the
// lists show and nothing animates.
import { router } from "expo-router";
import type { ReactNode } from "react";
import type { SFSymbol } from "sf-symbols-typescript";
import { spaceInitials } from "../../../../packages/kybern-client/src/spaces";
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

/**
 * A native iOS menu can't draw a SpaceTile: the letter in a filled square
 * ("p.square.fill") is the closest system mark, monochrome like its siblings.
 */
function spaceSymbol(name: string): SFSymbol {
  const letter = spaceInitials(name).charAt(0).toLowerCase();
  return (/^[a-z]$/.test(letter) ? `${letter}.square.fill` : "square.fill") as SFSymbol;
}

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
              leading: <SpaceTile space={space} size={20} />,
              nativeIcon: spaceSymbol(space.name),
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
 * A value that opens a menu, as a capsule: optional mark, the value, ⌄. The
 * space chip and the Notes/Tasks project filter share it.
 */
export function ValueCapsule({
  leading,
  label,
  compact = false,
}: {
  leading?: ReactNode;
  label: string;
  compact?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: compact ? 32 : 36,
        paddingStart: leading ? space.xs + 2 : space.md,
        paddingEnd: space.md,
        borderRadius: radius.full,
        backgroundColor: colors.raised,
      }}
    >
      {leading}
      <T variant="subhead" numberOfLines={1} style={{ fontWeight: "600", flexShrink: 1 }}>
        {label}
      </T>
      <Icon name="chevron.up.chevron.down" size={12} color={colors.muted} />
    </View>
  );
}

/**
 * The active space as a chip that opens the switcher. Shown only with two or more
 * spaces (with one, there is nothing to switch to) unless `always`, which keeps
 * New space and Manage spaces reachable on screens without another way there.
 */
export function SpaceSwitcher({ compact = false, always = false }: { compact?: boolean; always?: boolean }) {
  const s = useSpaces();
  const items = useSpaceMenuItems();
  const active = s.spaces.find((space) => space.id === currentSpaceId(s));
  if (!active || (s.spaces.length < 2 && !always)) return null;
  return (
    <MenuButton items={items} title="Space" label={`Space: ${active.name}. Switch space`} radius={radius.full}>
      <ValueCapsule
        compact={compact}
        label={active.name}
        leading={<SpaceTile space={active} size={compact ? 20 : 22} />}
      />
    </MenuButton>
  );
}
