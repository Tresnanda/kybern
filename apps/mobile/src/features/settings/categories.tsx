// The Settings categories: which group each sits in, its icon, the current value
// the root list shows, and the page that renders it.
import { router } from "expo-router";
import type { ReactNode } from "react";
import { AUTONOMY_OPTIONS, effectiveCoordinatorSettings } from "../../../../../packages/kybern-client/src/coordinatorSettings";
import { useAccounts } from "../../state/accounts";
import { count } from "../../state/format";
import { activeEnvironment, useApp } from "../../state/runtime";
import { useSettings } from "../../state/settings";
import type { IconName } from "../../ui/primitives";
import { useTheme } from "../../ui/theme";
import { AccessSettings } from "./Access";
import { AccountsSettings } from "./Accounts";
import { AgentsSettings } from "./Agents";
import { APPEARANCE_LABELS, AppearanceSettings } from "./Appearance";
import { AppUpdatesSettings, appVersion } from "./AppUpdates";
import { ComputersSettings } from "./Computers";
import { ComputerUseSettingsPage } from "./ComputerUse";
import { DelegationSettings } from "./Delegation";
import { GeneralSettings } from "./General";
import { IntegrationsSettings } from "./Integrations";
import { connectionRoute, permissionLabel } from "./labels";
import { SystemSettings } from "./System";
import { UsageSettings } from "./Usage";

export type CategoryId =
  | "appearance"
  | "computers"
  | "updates"
  | "general"
  | "agents"
  | "delegation"
  | "accounts"
  | "usage"
  | "integrations"
  | "computer"
  | "system"
  | "access";

export type Category = { id: CategoryId; title: string; icon: IconName; value?: string };

export const TITLES: Record<CategoryId, string> = {
  appearance: "Appearance",
  computers: "Computers",
  updates: "App updates",
  general: "General",
  agents: "Agents",
  delegation: "Delegation",
  accounts: "Accounts",
  usage: "Usage",
  integrations: "Connectors and plugins",
  computer: "Computer use",
  system: "Background & updates",
  access: "Access",
};

/** Old links used "defaults" for General. */
export const categoryOf = (value: string | undefined): CategoryId =>
  value === "defaults" ? "general" : value && value in TITLES ? (value as CategoryId) : "appearance";

/** The two groups of the root list, with each row's current value. */
export function useCategories(): { phone: Category[]; computer: Category[]; computerName: string } {
  const app = useApp();
  const { appearance } = useTheme();
  const { settings } = useSettings();
  const { accounts, loaded } = useAccounts();
  const environment = activeEnvironment();
  const open = app.status === "open";
  const phone: Category[] = [
    { id: "appearance", title: TITLES.appearance, icon: "circle.lefthalf.filled", value: APPEARANCE_LABELS[appearance] },
    {
      id: "computers",
      title: TITLES.computers,
      icon: "laptopcomputer",
      value: environment ? environment.name : "Not connected",
    },
    { id: "updates", title: TITLES.updates, icon: "arrow.clockwise", value: appVersion() },
  ];
  const on = (value: string | undefined) => (open && settings ? value : undefined);
  const computer: Category[] = [
    { id: "general", title: TITLES.general, icon: "slider.horizontal.3", value: on(settings ? permissionLabel(settings.default_permission_mode) : undefined) },
    { id: "agents", title: TITLES.agents, icon: "sparkles", value: open && app.providers.length ? count(app.providers.filter((p) => p.available).length, "agent") : undefined },
    {
      id: "delegation",
      title: TITLES.delegation,
      icon: "person.2",
      value: on(settings ? AUTONOMY_OPTIONS.find((o) => o.value === effectiveCoordinatorSettings(settings.orchestration, null).lead_autonomy)?.label : undefined),
    },
    { id: "accounts", title: TITLES.accounts, icon: "person.crop.circle", value: open && loaded && accounts.length ? count(accounts.length, "account") : undefined },
    { id: "usage", title: TITLES.usage, icon: "chart.bar" },
    { id: "integrations", title: TITLES.integrations, icon: "puzzlepiece.extension" },
    { id: "computer", title: TITLES.computer, icon: "display", value: on(settings ? (settings.computer_use.enabled ? "On" : "Off") : undefined) },
    { id: "system", title: TITLES.system, icon: "clock", value: on(settings?.background.save_power_on_battery ? "Saving power" : undefined) },
    { id: "access", title: TITLES.access, icon: "lock.shield", value: environment && open ? connectionRoute(environment.url) : undefined },
  ];
  return { phone, computer, computerName: environment?.name ?? "Your computer" };
}

/** A category's page: only its groups; the host supplies the scroll view. */
export function SettingsBody({ category }: { category: CategoryId }): ReactNode {
  switch (category) {
    case "appearance":
      return <AppearanceSettings />;
    case "computers":
      return <ComputersSettings />;
    case "updates":
      return <AppUpdatesSettings />;
    case "general":
      return <GeneralSettings />;
    case "agents":
      return <AgentsSettings />;
    case "delegation":
      return <DelegationSettings />;
    case "accounts":
      return <AccountsSettings />;
    case "usage":
      return <UsageSettings />;
    case "integrations":
      return <IntegrationsSettings />;
    case "computer":
      return <ComputerUseSettingsPage />;
    case "system":
      return <SystemSettings />;
    case "access":
      return <AccessSettings />;
  }
}

/** Open a category on the phone, where each is its own page. */
export function openCategory(id: CategoryId) {
  if (id === "updates") router.push("/app-updates");
  else if (id === "integrations") router.push("/integrations");
  else router.push({ pathname: "/settings-detail", params: { category: id } });
}
