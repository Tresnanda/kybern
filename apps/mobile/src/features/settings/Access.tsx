// Access: which computer this phone reaches and how. A phone paired with a code
// has no access scopes, so paired devices and Tailscale stay on the computer;
// a full-access token keeps those controls here.
import { useEffect, useState } from "react";
import type { TokenInfo } from "../../state/protocol";
import { activeEnvironment, currentClient, errorText, rpc, useApp } from "../../state/runtime";
import { loadSettings, useSettings } from "../../state/settings";
import { confirm } from "../../ui/Alert";
import { ListRow } from "../../ui/List";
import { Empty, ErrorBanner } from "../../ui/primitives";
import { Section, ToggleRow, WithSettings } from "./common";
import { canManageAccess, connectionRoute, shortAddress } from "./labels";

export function AccessSettings() {
  return (
    <WithSettings>
      <AccessBody />
    </WithSettings>
  );
}

function AccessBody() {
  const app = useApp();
  const environment = activeEnvironment();
  const info = currentClient()?.info;
  const manage = canManageAccess(info?.scopes);
  return (
    <>
      <Section
        title="This phone"
        first
        footer={manage ? null : "Manage paired devices and Tailscale access on your computer."}
      >
        <ListRow title="Computer" value={environment?.name ?? info?.hostname ?? "Not connected"} />
        {environment ? <ListRow title="Connected over" value={connectionRoute(environment.url)} /> : null}
        {environment ? <ListRow title="Address" value={shortAddress(environment.url)} /> : null}
        {info ? <ListRow title="Kybern" value={info.version} /> : null}
      </Section>
      {manage ? <ManageAccess key={app.activeId} /> : null}
    </>
  );
}

function ManageAccess() {
  const { settings } = useSettings();
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    rpc("access.tokens.list", {})
      .then((r) => live && setTokens(r.tokens.filter((t) => !t.revoked)))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, []);
  const revoke = (token: TokenInfo) =>
    confirm({
      title: `Revoke “${token.label}”?`,
      message: "This device loses access until it pairs again.",
      confirm: "Revoke access",
      onConfirm: () => {
        rpc("access.tokens.revoke", { token_id: token.id })
          .then(() => setTokens((list) => list?.filter((t) => t.id !== token.id) ?? null))
          .catch((e) => setError(errorText(e)));
      },
    });
  return (
    <>
      <ErrorBanner error={error} />
      <Section title="Network" footer="Paired devices on your private Tailscale network can reach this computer.">
        <ToggleRow
          title="Connect over Tailscale"
          value={settings?.access.tailscale ?? false}
          disabled={busy}
          onChange={(value) => {
            setBusy(true);
            rpc("access.exposure.set", { tailscale: value })
              .then(() => loadSettings())
              .catch((e) => setError(errorText(e)))
              .finally(() => setBusy(false));
          }}
        />
      </Section>
      <Section title="Paired devices" footer={tokens?.length ? "Swipe or touch and hold a device to revoke it." : null}>
        {tokens === null ? null : tokens.length === 0 ? (
          <Empty variant="inline" title="No paired devices." />
        ) : (
          tokens.map((token) => (
            <ListRow
              key={token.id}
              title={token.label}
              subtitle={token.last_used_at ? `Last used ${new Date(token.last_used_at).toLocaleDateString()}` : "Not used yet"}
              leading="lock.shield"
              menu={[{ title: "Revoke access", icon: "trash", destructive: true, onPress: () => revoke(token) }]}
              swipe={{ trailing: [{ title: "Revoke", icon: "trash", tone: "negative", onPress: () => revoke(token) }] }}
            />
          ))
        )}
      </Section>
    </>
  );
}
