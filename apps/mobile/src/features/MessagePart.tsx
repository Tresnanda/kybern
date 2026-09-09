import { Image, View } from "react-native";
import { httpBase, type ContentPart } from "../state/protocol";
import { activeEnvironment } from "../state/runtime";
import { Icon, T, styles } from "../ui/primitives";

export function imageSource(part: ContentPart, localUri?: string) {
  if (localUri) return { uri: localUri };
  if (part.type === "image")
    return { uri: `data:${part.media_type};base64,${part.data}` };
  if (part.type === "attachment" && part.media_type.startsWith("image/")) {
    const env = activeEnvironment();
    if (env)
      return {
        uri: `${httpBase(env.url)}/assets/${encodeURIComponent(part.asset_id)}`,
        headers: { authorization: `Bearer ${env.token}` },
      };
  }
  return undefined;
}

export function MessagePart({
  part,
  localUri,
  selectable = true,
  fillImage = false,
}: {
  part: ContentPart;
  localUri?: string;
  selectable?: boolean;
  fillImage?: boolean;
}) {
  const source = imageSource(part, localUri);
  if (source)
    return (
      <Image
        fadeDuration={0}
        source={source}
        accessibilityLabel="Attached image"
        style={{
          width: fillImage ? "100%" : 220,
          maxWidth: "100%",
          height: fillImage ? "100%" : 170,
          borderRadius: 12,
        }}
        resizeMode="contain"
      />
    );
  if (part.type === "text") return <T selectable={selectable}>{part.text}</T>;
  if (part.type === "image") return null;
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
      <T variant="caption">
        {part.type === "attachment" || part.type === "skill"
          ? part.name
          : part.type === "file_mention"
            ? part.path
            : (part.display_name ?? part.name)}
      </T>
    </View>
  );
}
