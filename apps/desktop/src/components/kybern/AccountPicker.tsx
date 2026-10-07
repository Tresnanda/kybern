import { Button } from "@/components/kit/button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { ChevronDownIcon } from "@/lib/kit/icons"
import type { ProviderInstance, ProviderSettings } from "@/protocol"

export function AccountPicker({ provider, settings, inherited, onChange }: {
  provider: ProviderInstance
  settings?: ProviderSettings
  inherited: boolean
  onChange: (instance: string | null) => void
}) {
  const name = provider.instance === "default" ? "Default account" : settings?.accounts?.[provider.instance]?.name ?? "Account unavailable"
  return <Menu>
    <MenuTrigger render={<Button variant="ghost" size="sm" className="min-w-0 max-w-40 gap-1 px-1.5" />} aria-label={`Account: ${name}${inherited ? ", follows defaults" : ", thread override"}`} title={`${name}${inherited ? " · Follows project and global defaults" : " · This thread"}`}>
      <span className="truncate">{name}</span><ChevronDownIcon className="size-3 shrink-0 opacity-60" />
    </MenuTrigger>
    <ComposerPickerMenuPopup align="end" side="top">
      <MenuGroup>
        <MenuGroupLabel>Account for the next message</MenuGroupLabel>
        <MenuRadioGroup value={inherited ? "inherit" : provider.instance} onValueChange={(value) => onChange(value === "inherit" ? null : value)}>
          <MenuRadioItem value="inherit">Follow project and global defaults</MenuRadioItem>
          <MenuRadioItem value="default">Default account</MenuRadioItem>
          {Object.entries(settings?.accounts ?? {}).map(([id, account]) => <MenuRadioItem key={id} value={id}><bdi>{account.name}</bdi></MenuRadioItem>)}
        </MenuRadioGroup>
      </MenuGroup>
    </ComposerPickerMenuPopup>
  </Menu>
}
