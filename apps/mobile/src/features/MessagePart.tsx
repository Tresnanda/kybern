import { View } from "react-native";
import { router } from "expo-router";
import type { ContentPart } from "../state/protocol";
import { assetSource, type RequestOwner } from "../state/machineRequests";
import { Icon, T, Tap, styles } from "../ui/primitives";
import { radius } from "../ui/theme";
import { AgentResultsList, ThreadMessageCard } from "./OrchestrationParts";
import { SystemRowLine } from "./CoordinatorCards";
import { threadReferenceLabel } from "../../../../packages/kybern-client/src/threadReferences";
import { AuthedImage } from "../ui/AuthedImage";

/** `owner` is the thread (or machine) the attachment lives on; without it, the computer the phone is at. */
export function imageSource(part: ContentPart, localUri?: string, owner?: RequestOwner) {
  if (localUri) return { uri: localUri };
  if (part.type === "image")
    return { uri: `data:${part.media_type};base64,${part.data}` };
  if (part.type === "attachment" && part.media_type.startsWith("image/")) {
    const source = assetSource(part.asset_id, owner);
    if (source) return source;
  }
  return undefined;
}

export function MessagePart({
  part,
  localUri,
  selectable = true,
  fillImage = false,
  owner,
}: {
  part: ContentPart;
  owner?: RequestOwner;
  localUri?: string;
  selectable?: boolean;
  fillImage?: boolean;
}) {
  const source = imageSource(part, localUri, owner);
  if (source)
    return (
      <AuthedImage
        fadeDuration={0}
        source={source}
        accessibilityLabel="Attached image"
        style={{
          width: fillImage ? "100%" : 220,
          maxWidth: "100%",
          height: fillImage ? "100%" : 170,
          borderRadius: radius.md,
        }}
        resizeMode="contain"
      />
    );
  if (part.type === "text") return <T selectable={selectable}>{part.text}</T>;
  if (part.type === "image") return null;
  if (part.type === "thread_message") return <ThreadMessageCard part={part} />;
  if (part.type === "agent_results") return <AgentResultsList items={part.items} />;
  if (part.type === "system_row") return <SystemRowLine text={part.text} />;
  if (part.type === "thread_reference")
    return (
      <Tap
        label={`Open referenced conversation, ${threadReferenceLabel(part)}`}
        onPress={() =>
          router.push({
            pathname: "/thread/[id]",
            params: { id: part.thread_id },
          })
        }
        style={[styles.line, { paddingHorizontal: 2 }]}
      >
        <Icon name="text.bubble" size={15} />
        <T variant="footnote" numberOfLines={1} style={{ flexShrink: 1 }}>
          {threadReferenceLabel(part)}
        </T>
        <Icon name="chevron.right" size={12} />
      </Tap>
    );
  return (
    <View style={styles.line}>
      <Icon
        name={
          part.type === "file_mention"
            ? "doc"
            : part.type === "skill"
              ? "sparkles"
              : "paperclip"
        }
        size={15}
      />
      <T variant="footnote">
        {part.type === "attachment" || part.type === "skill"
          ? part.name
          : part.type === "file_mention"
            ? part.path
            : (part.display_name ?? part.name)}
      </T>
    </View>
  );
}
