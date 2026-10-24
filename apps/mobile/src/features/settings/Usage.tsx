// Usage: each agent's plan limits (live from the computer), then what turns cost.
import { useEffect, useState } from "react";
import type { ProviderLimits, UsageSummaryResult } from "../../state/protocol";
import { PROVIDER_DISPLAY_NAME } from "../../state/protocol";
import { useAccounts, loadAccounts } from "../../state/accounts";
import { count } from "../../state/format";
import { errorText, rpc, useApp } from "../../state/runtime";
import { limitCards, loadUsageLimits, useUsageLimits } from "../../state/usage";
import { ListRow, SectionHeader } from "../../ui/List";
import { Empty, ErrorBanner } from "../../ui/primitives";
import { ProviderMark } from "../../ui/ProviderMark";
import { Segmented } from "../../ui/Segmented";
import { View } from "react-native";
import { space } from "../../ui/theme";
import { Section } from "./common";
import { limitLabel, resetsLabel, staleLabel, usedPercent } from "./labels";
import { UsageRing } from "./UsageRing";

type Group = "provider" | "model" | "day";

export function UsageSettings() {
  const app = useApp();
  const { limits, error, loading } = useUsageLimits();
  const { accounts } = useAccounts();
  useEffect(() => {
    if (app.status !== "open") return;
    void loadUsageLimits(true);
    void loadAccounts();
  }, [app.status, app.activeId]);
  const cards = limitCards(limits).filter((card) => card.limits.length);
  const now = Date.now();
  const title = (card: ProviderLimits) => {
    const agent = PROVIDER_DISPLAY_NAME[card.provider] ?? card.provider;
    const account = card.instance
      ? accounts.find((a) => a.provider.kind === card.provider && a.provider.instance === card.instance)?.name
      : null;
    return [account ? `${agent} · ${account}` : agent, card.plan].filter(Boolean).join(" · ");
  };
  const footer = (card: ProviderLimits) =>
    limits?.refreshing?.includes(card.provider)
      ? "Updating…"
      : (staleLabel(card.stale) ?? (card.updated_at ? `Updated ${new Date(card.updated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : null));
  return (
    <>
      <ErrorBanner error={error} onRetry={() => void loadUsageLimits(true)} />
      {cards.length === 0 ? (
        <>
          <SectionHeader title="Plan limits" inset first />
          <Empty
            variant="inline"
            title={app.status !== "open" ? "Connect your computer to see plan limits." : loading ? "Reading plan limits…" : "No agent has reported plan limits yet."}
          />
        </>
      ) : (
        cards.map((card, index) => (
          <Section key={`${card.provider}:${card.instance ?? ""}`} title={title(card)} first={index === 0} footer={footer(card)}>
            {card.limits.map((limit) => {
              const percent = usedPercent(limit);
              return (
                <ListRow
                  key={limit.name + limit.window_minutes}
                  title={limitLabel(limit, card.provider)}
                  subtitle={resetsLabel(limit.resets_at, now) ?? undefined}
                  leading={<UsageRing percent={percent} />}
                  meta={percent === null ? "—" : `${Math.round(percent)}%`}
                  label={`${limitLabel(limit, card.provider)}, ${percent === null ? "unknown" : `${Math.round(percent)} percent used`}`}
                />
              );
            })}
          </Section>
        ))
      )}
      <Cost />
    </>
  );
}

function Cost() {
  const app = useApp();
  const [group, setGroup] = useState<Group>("provider");
  const [usage, setUsage] = useState<UsageSummaryResult>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (app.status !== "open") return;
    let live = true;
    rpc("usage.summary", { group_by: group })
      .then((value) => {
        if (!live) return;
        setUsage(value);
        setError("");
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [app.status, app.activeId, group]);
  if (app.status !== "open") return null;
  const tokens = (row: UsageSummaryResult["total"]) =>
    count(row.usage.input_tokens + row.usage.output_tokens, "token");
  const rowTitle = (key: string) =>
    group === "provider" ? (PROVIDER_DISPLAY_NAME[key as keyof typeof PROVIDER_DISPLAY_NAME] ?? key) : key;
  return (
    <>
      <SectionHeader title="Cost" inset />
      <View style={{ marginBottom: space.md }}>
        <Segmented
          compact
          label="Group cost by"
          value={group}
          onChange={setGroup}
          options={[
            { value: "provider", label: "Agent" },
            { value: "model", label: "Model" },
            { value: "day", label: "Day" },
          ]}
        />
      </View>
      <ErrorBanner error={error} />
      {usage ? (
        <Section footer="Estimated from each agent's reported tokens.">
          <ListRow
            title="Total"
            subtitle={`${count(usage.total.turns, "turn")} · ${tokens(usage.total)}`}
            meta={`$${usage.total.cost_usd.toFixed(2)}`}
          />
          {usage.rows.map((row) => (
            <ListRow
              key={row.key}
              title={rowTitle(row.key)}
              leading={group === "provider" && row.key in PROVIDER_DISPLAY_NAME ? <ProviderMark kind={row.key as keyof typeof PROVIDER_DISPLAY_NAME} size={20} /> : undefined}
              subtitle={`${count(row.turns, "turn")} · ${tokens(row)}`}
              meta={`$${row.cost_usd.toFixed(2)}`}
            />
          ))}
        </Section>
      ) : null}
    </>
  );
}
