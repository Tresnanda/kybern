// "Earlier on Mac · 12 messages": what a thread moved here with "Continue on…" said and did on its first machine
// (design §7.2). Collapsed by default; opened it lists the newest messages, with tool calls as one quiet line each.
import { useState } from "react";
import { View } from "react-native";
import { historyLabel } from "../../../../packages/kybern-client/src/continueOn";
import type { Block } from "../state/transcript";
import { T } from "../ui/primitives";
import { space } from "../ui/theme";
import { SystemRowLine } from "./CoordinatorCards";

/** The most items an opened block lists. */
const SHOWN = 80;

export function HistoryRow({ block }: { block: Extract<Block, { kind: "history" }> }) {
  const [open, setOpen] = useState(false);
  const items = open ? block.items.slice(-SHOWN) : [];
  const hidden = block.items.length - items.length;
  return (
    <View style={{ gap: space.sm }}>
      <SystemRowLine
        text={historyLabel(block.fromMachineName, block.items, block.omitted)}
        hint={open ? "Hides the earlier conversation" : "Shows the earlier conversation"}
        onPress={() => setOpen(!open)}
      />
      {open && hidden > 0 ? (
        <T variant="caption" tone="muted">
          {`${hidden} earlier ${hidden === 1 ? "item" : "items"} not shown`}
        </T>
      ) : null}
      {items.map((item, index) => (
        <T
          key={index}
          variant={item.role === "tool" ? "caption" : "footnote"}
          tone={item.role === "user" ? undefined : "secondary"}
          selectable
        >
          {item.role === "user" ? `You: ${item.text}` : item.text}
        </T>
      ))}
    </View>
  );
}
