// An `Image` whose source needs the daemon's token. Android's image loader drops `source.headers`, so the daemon answered
// every chat image, attachment and space logo with 401 there. On Android such a source is downloaded with the header
// into the cache and shown from the file; iOS sends the header itself and loads it directly.
import { Directory, File, Paths } from "expo-file-system";
import { useEffect, useState, type ComponentProps } from "react";
import { Image, Platform, type ImageSourcePropType } from "react-native";

type Source = { uri: string; headers?: Record<string, string> };
type Props = Omit<ComponentProps<typeof Image>, "source"> & { source: ImageSourcePropType | Source | undefined };

const MAX_FILES = 200;
/** Downloads by URL, kept for the session; a failed one is forgotten so the next attempt fetches again. */
const downloads = new Map<string, Promise<string>>();

function fileName(uri: string): string {
  // FNV-1a over the URL: stable, and the same image is fetched once.
  let hash = 0x811c9dc5;
  for (let i = 0; i < uri.length; i++) hash = Math.imul(hash ^ uri.charCodeAt(i), 0x01000193) >>> 0;
  return `${hash.toString(16)}-${uri.length}`;
}

function download(source: Source & { headers: Record<string, string> }): Promise<string> {
  const known = downloads.get(source.uri);
  if (known) return known;
  const dir = new Directory(Paths.cache, "kybern-images");
  const pending = (async () => {
    dir.create({ idempotent: true, intermediates: true });
    const file = await File.downloadFileAsync(source.uri, new File(dir, fileName(source.uri)), { headers: source.headers, idempotent: true });
    return file.uri;
  })();
  downloads.set(source.uri, pending);
  if (downloads.size > MAX_FILES) downloads.delete(downloads.keys().next().value!);
  pending.catch(() => downloads.delete(source.uri));
  return pending;
}

const needsDownload = (source: Props["source"]): source is Source & { headers: Record<string, string> } =>
  Platform.OS === "android" && !!source && typeof source === "object" && !Array.isArray(source) &&
  typeof (source as Source).uri === "string" && !!(source as Source).headers && /^https?:/i.test((source as Source).uri);

export function AuthedImage({ source, onError, ...props }: Props) {
  const download_ = needsDownload(source);
  const [file, setFile] = useState<{ from: string; uri: string } | null>(null);
  useEffect(() => {
    if (!needsDownload(source)) return;
    let live = true;
    download(source).then(
      (uri) => live && setFile({ from: source.uri, uri }),
      (error: unknown) => live && onError?.({ nativeEvent: { error: String((error as Error)?.message ?? error) } } as never),
    );
    return () => {
      live = false;
    };
  }, [download_ ? source.uri : null]);
  if (!download_) return <Image {...props} source={source as ImageSourcePropType | undefined} onError={onError} />;
  const shown = file?.from === source.uri ? { uri: file.uri } : undefined;
  return <Image {...props} source={shown} onError={onError} />;
}
