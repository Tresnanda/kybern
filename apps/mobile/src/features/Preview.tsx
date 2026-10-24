// Preview (parity P2-1): dev servers running on the computer, an address field, and the page in
// a WebView loaded from a short-lived ticket URL. Device sizes come from the shared
// `previewViewport.ts`; a preset renders the page at that size, scaled to fit. Used by the
// full-screen route and the iPad inspector's Preview tab.
import { router, usePathname } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { WebView } from "react-native-webview";
import {
  RESPONSIVE_PRESET_ID,
  VIEWPORT_PRESETS,
  viewportLayout,
  viewportPreset,
} from "../../../../packages/kybern-client/src/previewViewport";
import type { PreviewServer } from "../state/protocol";
import { closePreview, onPreviewRequested, openPreview, usePreviewRequest, type PreviewPage } from "../state/previews";
import { errorText, getState, rpc, useApp } from "../state/runtime";
import { useLayout } from "../state/layout";
import { showToast } from "../ui/Toast";
import { MenuButton, type MenuItem } from "../ui/ActionMenu";
import { confirm } from "../ui/Alert";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../ui/List";
import { Empty, ErrorBanner, IconButton, T } from "../ui/primitives";
import { SearchField } from "../ui/Search";
import { space, useTheme } from "../ui/theme";
import { Working } from "../ui/Working";

const serverTitle = (server: PreviewServer) => server.title || server.framework || `localhost:${server.port}`;
const serverDetail = (server: PreviewServer) =>
  [server.process_name, server.cwd?.split("/").filter(Boolean).at(-1)].filter(Boolean).join(" · ") || server.url;

export function PreviewPane({ threadId, initialTarget }: { threadId: string; initialTarget?: string }) {
  const app = useApp();
  const { colors } = useTheme();
  const [address, setAddress] = useState(initialTarget ?? "");
  const [page, setPage] = useState<PreviewPage | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [servers, setServers] = useState<PreviewServer[] | null>(null);
  const [preset, setPreset] = useState(RESPONSIVE_PRESET_ID);
  const [slot, setSlot] = useState({ w: 0, h: 0 });
  const [title, setTitle] = useState("");
  const web = useRef<WebView>(null);
  const pageRef = useRef<PreviewPage | null>(null);
  pageRef.current = page;
  const request = usePreviewRequest(threadId);
  const handled = useRef(0);

  const loadServers = useCallback(async () => {
    try {
      const result = await rpc("previews.servers.list", { thread_id: threadId });
      setServers(result.servers);
    } catch (e) {
      setServers([]);
      setError(errorText(e));
    }
  }, [threadId]);
  useEffect(() => {
    if (app.status === "open") void loadServers();
  }, [loadServers, app.status, app.activeId]);
  useEffect(() => () => closePreview(pageRef.current), []);

  const open = useCallback(
    async (input: string, allowFolder = false) => {
      setOpening(true);
      setError("");
      const result = await openPreview(threadId, input, allowFolder);
      setOpening(false);
      if (result.kind === "page") {
        closePreview(pageRef.current);
        setTitle("");
        setAddress(result.page.address);
        setPage(result.page);
      } else if (result.kind === "browser") void Linking.openURL(result.url);
      else if (result.kind === "permission") {
        if (!result.grantable) setError(`Kybern can't preview files in ${result.folder}. Move the file into the project.`);
        else
          confirm({
            title: "Allow previews from this folder?",
            message: `${result.folder} is outside the project. Kybern remembers this choice on your computer.`,
            confirm: "Allow",
            destructive: false,
            onConfirm: () => void open(input, true),
          });
      } else setError(result.message);
    },
    [threadId],
  );
  useEffect(() => {
    if (initialTarget && app.status === "open") void open(initialTarget);
  }, [initialTarget, app.status === "open"]);
  // A page an agent opened while this pane is mounted replaces the current one.
  useEffect(() => {
    if (!request || request.at <= handled.current || app.status !== "open" || Date.now() - request.at > 10 * 60_000) return;
    handled.current = request.at;
    if (request.target !== initialTarget) void open(request.target);
  }, [request, app.status]);

  const size = viewportPreset(preset);
  const layout = size && slot.w > 0 ? viewportLayout({ w: size.w, h: size.h }, slot) : null;
  const deviceItems: MenuItem[] = [
    { title: "Fit to screen", checked: preset === RESPONSIVE_PRESET_ID, onPress: () => setPreset(RESPONSIVE_PRESET_ID) },
    ...(["phone", "tablet", "desktop"] as const).map((group) => ({
      title: group === "phone" ? "Phones" : group === "tablet" ? "Tablets" : "Computers",
      inline: true,
      children: VIEWPORT_PRESETS.filter((p) => p.group === group).map((p) => ({
        title: p.label,
        subtitle: `${p.w} × ${p.h}`,
        checked: preset === p.id,
        onPress: () => setPreset(p.id),
      })),
    })),
  ];

  const bar = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingStart: space.lg, paddingEnd: space.xs, paddingVertical: space.sm }}>
      {page && (
        <IconButton
          name="chevron.left"
          label="Back to dev servers"
          onPress={() => {
            closePreview(page);
            setPage(null);
            void loadServers();
          }}
        />
      )}
      <View style={{ flex: 1 }}>
        <SearchField placeholder="Port, address or file" value={address} onChangeText={setAddress} onSubmit={() => void open(address)} />
      </View>
      {page ? (
        <>
          <IconButton name="arrow.clockwise" label="Reload page" onPress={() => web.current?.reload()} />
          <MenuButton icon="iphone" label="Device size" title="Show the page at" items={deviceItems} />
        </>
      ) : null}
    </View>
  );

  if (!page)
    return (
      <View style={{ flex: 1 }}>
        {bar}
        <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space["2xl"] }} keyboardShouldPersistTaps="handled">
          <ErrorBanner error={error} />
          {opening ? (
            <Working label="Opening preview" />
          ) : servers === null ? (
            <Working label="Looking for dev servers" />
          ) : servers.length ? (
            <>
              <SectionHeader
                title="Running on your computer"
                count={servers.length}
                action={{ title: "Refresh", onPress: () => void loadServers() }}
                first
              />
              <InsetGroup>
                {servers.map((server) => (
                  <ListRow
                    key={server.url}
                    title={serverTitle(server)}
                    subtitle={`${server.url.replace(/^https?:\/\//, "")} · ${serverDetail(server)}`}
                    subtitleLines={1}
                    leading="globe"
                    chevron
                    onPress={() => void open(server.url)}
                  />
                ))}
              </InsetGroup>
              <SectionFooter>Pages load through your computer, so localhost works from here.</SectionFooter>
            </>
          ) : (
            <Empty
              icon="globe"
              title="No dev servers running"
              detail="Start one in a terminal, or type a port like 5173 above."
            />
          )}
        </ScrollView>
      </View>
    );

  return (
    <View style={{ flex: 1 }}>
      {bar}
      <ErrorBanner error={error} />
      {!!title && (
        <T variant="footnote" tone="secondary" numberOfLines={1} style={{ paddingHorizontal: space.lg, paddingBottom: space.xs }}>
          {title}
        </T>
      )}
      <View
        style={{ flex: 1, backgroundColor: size ? colors.grouped : colors.background, overflow: "hidden" }}
        onLayout={(e) => setSlot({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      >
        <View
          style={
            layout
              ? { position: "absolute", left: layout.left, top: layout.top, width: layout.width, height: layout.height }
              : { flex: 1 }
          }
        >
          <View
            style={
              layout && size
                ? {
                    width: size.w,
                    height: size.h,
                    // RN scales around the centre; shift so the scaled page sits at the box's top-left.
                    transform: [
                      { translateX: (layout.width - size.w) / 2 },
                      { translateY: (layout.height - size.h) / 2 },
                      { scale: layout.scale },
                    ],
                    borderRadius: 4,
                    overflow: "hidden",
                    boxShadow: "0 2px 12px #0000002E",
                  }
                : { flex: 1 }
            }
          >
            <WebView
              ref={web}
              key={page.uri}
              source={{ uri: page.uri }}
              originWhitelist={["http://*", "https://*"]}
              onShouldStartLoadWithRequest={(req) => {
                if (req.url === "about:blank" || req.url.startsWith(page.scope)) return true;
                // Subframes (embeds, iframes) load in place; a top-level link elsewhere opens the browser.
                if (req.isTopFrame === false) return true;
                if (/^https?:\/\//i.test(req.url)) void Linking.openURL(req.url);
                return false;
              }}
              onNavigationStateChange={(nav) => setTitle(nav.title && !/^https?:/.test(nav.title) ? nav.title : "")}
              onHttpError={(e) => e.nativeEvent.statusCode >= 500 && setError(`The dev server answered ${e.nativeEvent.statusCode}. Check its terminal on your computer.`)}
              onError={(e) => setError(e.nativeEvent.description || "The page could not load. Check that the dev server is still running.")}
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled={false}
              thirdPartyCookiesEnabled={false}
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              setSupportMultipleWindows={false}
              allowsBackForwardNavigationGestures
              style={{ flex: 1, backgroundColor: "#FFFFFF" }}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * Mounted once in the root layout: a page an agent opens shows in the inspector when its
 * thread is on screen on a wide layout, otherwise as a toast that opens it.
 */
export function PreviewRequests() {
  const { regular, openInspector } = useLayout();
  const pathname = usePathname();
  const here = useRef({ regular, pathname, openInspector });
  here.current = { regular, pathname, openInspector };
  useEffect(
    () =>
      onPreviewRequested((request) => {
        const { regular, pathname, openInspector } = here.current;
        if (regular && pathname === `/thread/${request.thread_id}`) return openInspector("preview");
        const thread = getState().threads.find((t) => t.id === request.thread_id);
        showToast(`${request.requested_by_agent ? "The agent" : "Kybern"} opened a preview${thread?.title ? ` in “${thread.title}”` : ""}`, {
          title: "Open",
          onPress: () => router.push({ pathname: "/preview", params: { threadId: request.thread_id, target: request.target } }),
        });
      }),
    [],
  );
  return null;
}
