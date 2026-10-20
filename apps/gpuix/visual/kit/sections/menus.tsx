// Desktop menu gallery: the real `components/kit/menu` composed like `AccountsSettings`/`NoteMenu` do (picker
// popup, groups, radio items, a checkbox item, shortcuts, a submenu, a destructive item). Open, anchored under
// a 120 x 28 trigger at (40, 40). The submenu section opens "Color" by hand (hover) from the state's driver.
import type { ComponentType } from 'react'
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from '@/components/kit/chat/ComposerPickerMenuPopup'
import {
  Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator,
  MenuShortcut, MenuSub, MenuSubTrigger, MenuTrigger,
} from '@/components/kit/menu'
import { CopyIcon, PencilIcon } from '@/lib/kit/icons'

function MenuDemo() {
  return (
    <div style={{ position: 'absolute', left: 40, top: 40 }}>
      <Menu open modal={false}>
        <MenuTrigger className="inline-flex h-7 w-[120px] items-center rounded-lg border border-border px-2 text-sm" data-testid="menu-trigger">Account</MenuTrigger>
        <ComposerPickerMenuPopup align="start" sideOffset={4} className="min-w-52" data-testid="menu-root">
          <MenuGroup>
            <MenuGroupLabel>Account</MenuGroupLabel>
            <MenuItem><PencilIcon />Rename<MenuShortcut>⌘R</MenuShortcut></MenuItem>
            <MenuItem><CopyIcon />Copy link</MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Appearance</MenuGroupLabel>
            <MenuRadioGroup value="dark">
              <MenuRadioItem value="light">Light</MenuRadioItem>
              <MenuRadioItem value="dark">Dark</MenuRadioItem>
              <MenuRadioItem value="system">System</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuCheckboxItem checked>Show hints</MenuCheckboxItem>
          <MenuSub>
            <MenuSubTrigger data-testid="menu-sub-trigger">Color</MenuSubTrigger>
            <ComposerPickerMenuSubPopup className="min-w-48" data-testid="menu-sub">
              <MenuRadioGroup value="green">
                <MenuRadioItem value="blue">Blue</MenuRadioItem>
                <MenuRadioItem value="green">Green</MenuRadioItem>
                <MenuRadioItem value="rose">Rose</MenuRadioItem>
              </MenuRadioGroup>
            </ComposerPickerMenuSubPopup>
          </MenuSub>
          <MenuSeparator />
          <MenuItem variant="destructive">Remove account</MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  )
}
export const sections: Record<string, ComponentType> = { menus: MenuDemo }
