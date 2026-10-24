// The daemon's summoned request cards on the phone: sign-in (`kybern_request_login`), a command's
// password prompt (`kybern_askpass`), a macOS permission (`kybern_request_permission`) and "point
// for me" (`kybern_request_pick`), plus the one quiet line a settled card leaves behind. Copy,
// inputs and records come from `packages/kybern-client/src/requestCards.ts` so they match the
// desktop. Things only the Mac can do (open System Settings, run a sign-in that changes the Mac's
// own login, point at a page) say so and keep Decline; the phone never pretends.
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Linking, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import {
  loginDoneTitle,
  loginTitle,
  loginWaitingLine,
  lockLine,
  formatCountdown,
  passwordCopy,
  passwordMeta,
  passwordPurpose,
  permissionGrantedTitle,
  permissionPane,
  permissionStillOffMeta,
  permissionStillOffTitle,
  permissionTitle,
  permissionWaitingLine,
  recordText,
  shortUrl,
  wrongAnswerError,
  type RequestRecord,
} from "../../../../packages/kybern-client/src/requestCards";
import { isElementPick, pickTitle } from "../../../../packages/kybern-client/src/pickRequest";
import type {
  ApprovalDecision,
  ApprovalRequest,
  FileEntry,
  LoginRequestInput,
  PermissionRequestInput,
  PickRequestInput,
  PromptRequestInput,
} from "../state/protocol";
import { errorText, getState, loadThread, refresh, rpc } from "../state/runtime";
import { actOnRequest, refreshRequestProgress, useRequestProgress } from "../state/requestProgress";
import { Button, ErrorBanner, Icon, T, Tap, type IconName } from "../ui/primitives";
import { haptics } from "../ui/haptics";
import { MONO, radius, space, type as typography, useTheme } from "../ui/theme";

/** The harness's short name in card copy ("Decline and tell Claude …"). */
const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi", omp: "Pi", cursor: "Cursor" };
export function agentFor(threadId: string) {
  const provider = getState().threads.find((thread) => thread.id === threadId)?.provider.kind;
  return AGENT_NAMES[provider ?? ""] ?? "The agent";
}

export async function respondApproval(approval: Pick<ApprovalRequest, "id" | "thread_id">, decision: ApprovalDecision) {
  await rpc("approvals.respond", { approval_id: approval.id, ...decision });
  await Promise.all([refresh(), loadThread(approval.thread_id)]);
}

/** A sentence for an action that failed: the daemon's own when it gave one. */
const failed = (e: unknown) => errorText(e) || "Unable to reach your computer. Check the connection and try again.";

/** The frame every request card shares: `card` fill, hairline, `lg` radius, 16 pt padding. */
export function RequestCardShell({ children, label, live = true }: { children: ReactNode; label?: string; live?: boolean }) {
  const { colors } = useTheme();
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      accessibilityLabel={label}
      accessibilityLiveRegion={live ? "polite" : undefined}
      style={{
        padding: space.lg,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        backgroundColor: colors.card,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        gap: space.md,
      }}
    >
      {children}
    </Animated.View>
  );
}

/** Icon tile, title and an optional chip ("gh", "macOS"), then the meta line. */
export function RequestHeader({
  icon,
  title,
  chip,
  meta,
  tone = "ink",
}: {
  icon: IconName;
  title: string;
  chip?: { label: string; mono?: boolean };
  meta?: string;
  tone?: "ink" | "positive";
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: radius.sm,
          backgroundColor: colors.raised,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} size={17} color={tone === "positive" ? colors.positive : colors.secondary} />
      </View>
      <View style={{ flex: 1, gap: space["2xs"] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <T variant="headline" style={{ flexShrink: 1 }}>
            {title}
          </T>
          {chip && (
            <View style={{ paddingHorizontal: space.sm, paddingVertical: space["2xs"], borderRadius: radius.xs, backgroundColor: colors.raised }}>
              <T variant={chip.mono ? "code" : "footnote"} tone="secondary">
                {chip.label}
              </T>
            </View>
          )}
        </View>
        {!!meta && (
          <T variant="subhead" tone="secondary">
            {meta}
          </T>
        )}
      </View>
    </View>
  );
}

/** Key–value rows in a quiet well (Account, Access, Signs in). */
function Well({ rows }: { rows: { key: string; value: string; mono?: boolean }[] }) {
  const { colors } = useTheme();
  if (!rows.length) return null;
  return (
    <View style={{ borderRadius: radius.md, backgroundColor: colors.raised, paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.xs }}>
      {rows.map((row) => (
        <View key={row.key} style={{ flexDirection: "row", gap: space.md }}>
          <T variant="footnote" tone="muted" style={{ width: 72 }}>
            {row.key}
          </T>
          <T variant={row.mono ? "code" : "footnote"} style={{ flex: 1 }} selectable>
            {row.value}
          </T>
        </View>
      ))}
    </View>
  );
}

/** Text with `backticked` spans set in mono, as the shared copy writes commands and files. */
function CodeText({ text, tone = "secondary" }: { text: string; tone?: "secondary" | "muted" }) {
  const { colors } = useTheme();
  return (
    <T variant="footnote" tone={tone}>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <Text key={i} style={{ fontFamily: MONO, color: colors.ink }}>
            {part.slice(1, -1)}
          </Text>
        ) : (
          part
        ),
      )}
    </T>
  );
}

/** A quiet status line with a live glyph and an optional trailing time. */
function StatusLine({ text, trailing, done = false }: { text: string; trailing?: ReactNode; done?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }} accessibilityLiveRegion="polite">
      <Icon name={done ? "checkmark.circle" : "clock"} size={15} color={done ? colors.positive : colors.secondary} />
      <T variant="subhead" tone="secondary" style={{ flex: 1 }}>
        {text}
      </T>
      {trailing}
    </View>
  );
}

/** "14:12 left", re-rendered once a second while on screen. */
function TimeLeft({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Date.parse(endsAt) - now;
  if (Number.isNaN(left)) return null;
  return (
    <T variant="footnote" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
      {`${formatCountdown(left)} left`}
    </T>
  );
}

/** Two buttons side by side: the quiet one first, the commit last. */
function Actions({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", gap: space.sm }}>{children}</View>;
}
const Half = ({ children }: { children: ReactNode }) => <View style={{ flex: 1 }}>{children}</View>;

/** Deny the card. A harness that drops the reason still ends the tool call. */
function useDecline(approval: ApprovalRequest) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decline = async (reason?: string) => {
    setBusy(true);
    setError("");
    try {
      await respondApproval(approval, reason ? { decision: "deny", reason } : { decision: "deny" });
    } catch (e) {
      setError(failed(e));
      setBusy(false);
    }
  };
  return { busy, error, decline };
}

// ---- sign-in ----

export function LoginRequestCard({ approval, input }: { approval: ApprovalRequest; input: LoginRequestInput }) {
  const { colors } = useTheme();
  const progress = useRequestProgress(approval.id);
  const phase = progress?.phase;
  const view = phase === "waiting" || phase === "verifying" ? "wait" : phase === "paste_code" ? "paste" : phase === "done" ? "done" : "ask";
  const agent = agentFor(approval.thread_id);
  const { busy, error, decline } = useDecline(approval);
  const [actError, setActError] = useState("");
  const [acting, setActing] = useState(false);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void refreshRequestProgress(approval.thread_id);
  }, [approval.id, approval.thread_id]);
  const act = async (action: string, value?: string) => {
    setActing(true);
    setActError("");
    try {
      await actOnRequest(approval.id, action, value);
      if (action === "paste") setCode("");
    } catch (e) {
      setActError(failed(e));
    } finally {
      setActing(false);
    }
  };
  const chip = { label: input.cli, mono: true };
  const shown = actError || error || (phase === "failed" ? progress?.error || "The sign-in did not finish. Try again on your computer." : "");

  if (view === "done")
    return (
      <RequestCardShell>
        <RequestHeader icon="checkmark.circle" tone="positive" title={loginDoneTitle(input.service, progress?.account)} chip={chip} />
        <StatusLine done text={`${agent} is continuing.`} />
      </RequestCardShell>
    );
  if (view === "wait")
    return (
      <RequestCardShell>
        <RequestHeader icon="key" title={loginTitle(input)} chip={chip} />
        {progress?.method !== "terminal" && !!progress?.user_code && (
          <View style={{ borderRadius: radius.md, backgroundColor: colors.raised, padding: space.md, gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <Text
                selectable
                style={{ flex: 1, fontFamily: MONO, fontSize: 22, lineHeight: 28, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] }}
                maxFontSizeMultiplier={1.6}
              >
                {progress.user_code}
              </Text>
              <Button
                size="medium"
                icon={copied ? "checkmark" : "doc.on.doc"}
                onPress={() => {
                  void Clipboard.setStringAsync(progress.user_code!).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "Copied" : "Copy code"}
              </Button>
            </View>
            {!!progress.url && <CodeText text={`Enter this code at \`${shortUrl(progress.url)}\`.`} />}
          </View>
        )}
        <StatusLine
          text={progress ? loginWaitingLine(progress) : "Waiting for you to finish in the browser…"}
          trailing={progress?.ends_at ? <TimeLeft endsAt={progress.ends_at} /> : undefined}
        />
        <ErrorBanner error={shown} />
        <Actions>
          <Half>
            <Button disabled={acting} onPress={() => void act("cancel")}>
              Cancel sign-in
            </Button>
          </Half>
          {progress?.method !== "terminal" && !!progress?.url && (
            <Half>
              <Button role="prominent" onPress={() => void Linking.openURL(progress.url!).catch(() => setActError("Unable to open the page. Copy the code and open it yourself."))}>
                Open page
              </Button>
            </Half>
          )}
        </Actions>
        {progress?.method === "terminal" && (
          <T variant="footnote" tone="muted">
            Finish the sign-in in the terminal on your computer. Kybern continues on its own.
          </T>
        )}
      </RequestCardShell>
    );
  if (view === "paste")
    return (
      <RequestCardShell>
        <RequestHeader icon="key" title={loginTitle(input)} chip={chip} meta={`${input.service} shows a verification code in the browser. Paste it here.`} />
        <TextInput
          accessibilityLabel="Verification code"
          value={code}
          onChangeText={setCode}
          placeholder="Paste the code"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          editable={!acting}
          onSubmitEditing={() => code.trim() && void act("paste", code.trim())}
          style={[typography.code, { minHeight: 48, borderRadius: radius.md, backgroundColor: colors.raised, paddingHorizontal: space.md, color: colors.ink, letterSpacing: 0 }]}
        />
        <ErrorBanner error={shown} />
        <Actions>
          <Half>
            <Button disabled={acting} onPress={() => void act("cancel")}>
              Cancel
            </Button>
          </Half>
          <Half>
            <Button role="prominent" busy={acting} disabled={!code.trim()} onPress={() => void act("paste", code.trim())}>
              Continue
            </Button>
          </Half>
        </Actions>
      </RequestCardShell>
    );
  return (
    <RequestCardShell label={loginTitle(input)}>
      <RequestHeader icon="key" title={loginTitle(input)} chip={chip} meta={input.reason || undefined} />
      <Well
        rows={[
          ...(input.account ? [{ key: "Account", value: input.account }] : []),
          ...(input.access ? [{ key: "Access", value: input.access }] : []),
          ...(input.signs_in ? [{ key: "Signs in", value: input.signs_in }] : []),
        ]}
      />
      <T variant="footnote" tone="secondary">
        Signing in changes your computer’s own login. Start it from Kybern on your computer; this card follows along here.
      </T>
      <ErrorBanner error={shown} />
      <Actions>
        <Half>
          <Button role="destructive" disabled={busy} onPress={() => void decline()}>
            Decline
          </Button>
        </Half>
        <Half>
          <Button busy={acting} onPress={() => void act(input.methods.includes("browser") ? "browser" : "terminal")}>
            Try from here
          </Button>
        </Half>
      </Actions>
    </RequestCardShell>
  );
}

// ---- password prompt ----

export function PromptRequestCard({ approval, input }: { approval: ApprovalRequest; input: PromptRequestInput }) {
  const { colors } = useTheme();
  const field = useRef<TextInput>(null);
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copy = passwordCopy(input);
  const purpose = passwordPurpose(input);
  const agent = agentFor(approval.thread_id);
  const threadTitle = getState().threads.find((thread) => thread.id === approval.thread_id)?.title ?? null;
  const respond = async (decision: ApprovalDecision) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await respondApproval(approval, decision);
      setValue("");
      haptics.success();
    } catch (e) {
      setError(failed(e));
      setBusy(false);
    }
  };
  const send = () => {
    if (!value) return field.current?.focus();
    void respond({ decision: "submit", response: input.secret ? { secret: value } : { value } });
  };
  const icon: IconName = copy.glyph === "shield" ? "lock.shield" : copy.glyph;
  if (purpose === "ssh_host_key")
    return (
      <RequestCardShell label={copy.title}>
        <RequestHeader icon={icon} title={copy.title} meta={passwordMeta(input, threadTitle)} />
        <Well
          rows={[
            ...(input.host ? [{ key: "Server", value: input.host, mono: true }] : []),
            ...(input.key_type ? [{ key: "Key", value: input.key_type, mono: true }] : []),
            ...(input.fingerprint ? [{ key: "Fingerprint", value: input.fingerprint, mono: true }] : []),
          ]}
        />
        <ErrorBanner error={error} />
        <Actions>
          <Half>
            <Button disabled={busy} onPress={() => void respond({ decision: "submit", response: { confirmed: false } })}>
              Don’t connect
            </Button>
          </Half>
          <Half>
            <Button role="prominent" busy={busy} onPress={() => void respond({ decision: "submit", response: { confirmed: true } })}>
              Trust server
            </Button>
          </Half>
        </Actions>
      </RequestCardShell>
    );
  return (
    <RequestCardShell label={copy.title}>
      <RequestHeader
        icon={icon}
        title={copy.title}
        chip={input.command ? { label: input.command, mono: true } : undefined}
        meta={passwordMeta(input, threadTitle)}
      />
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 48, borderRadius: radius.md, backgroundColor: colors.raised, paddingStart: space.md }}>
        <TextInput
          ref={field}
          accessibilityLabel={copy.label ?? copy.placeholder}
          value={value}
          onChangeText={setValue}
          editable={!busy}
          secureTextEntry={input.secret && !shown}
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          spellCheck={false}
          returnKeyType="send"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={send}
          placeholder={copy.placeholder}
          placeholderTextColor={colors.muted}
          selectionColor={colors.accent}
          underlineColorAndroid="transparent"
          style={[typography.callout, { flex: 1, color: colors.ink, paddingVertical: space.sm, letterSpacing: 0, fontFamily: shown || !input.secret ? MONO : undefined }]}
        />
        {input.secret && (
          <Tap label={shown ? "Hide the value" : "Show the value"} selected={shown} onPress={() => setShown(!shown)} style={{ paddingHorizontal: space.md, alignItems: "center" }}>
            <T variant="footnote" tone="secondary">
              {shown ? "Hide" : "Show"}
            </T>
          </Tap>
        )}
      </View>
      <ErrorBanner error={error || wrongAnswerError(input) || ""} />
      <Actions>
        <Half>
          <Button disabled={busy} onPress={() => void respond({ decision: "deny" })}>
            Cancel
          </Button>
        </Half>
        <Half>
          <Button role="prominent" busy={busy} disabled={!value} onPress={send}>
            Send
          </Button>
        </Half>
      </Actions>
      <View style={{ flexDirection: "row", gap: space.xs + 2 }}>
        <Icon name="lock" size={12} color={colors.muted} />
        <T variant="footnote" tone="muted" style={{ flex: 1 }}>
          {copy.hint ? `${lockLine(agent)} ${copy.hint}` : lockLine(agent)}
        </T>
      </View>
    </RequestCardShell>
  );
}

// ---- macOS permission ----

export function PermissionRequestCard({ approval, input }: { approval: ApprovalRequest; input: PermissionRequestInput }) {
  const progress = useRequestProgress(approval.id);
  const phase = progress?.phase;
  const view = phase === "waiting" ? "wait" : phase === "not_granted" ? "off" : phase === "done" ? "done" : "ask";
  const agent = agentFor(approval.thread_id);
  const { busy, error, decline } = useDecline(approval);
  const [acting, setActing] = useState(false);
  const [actError, setActError] = useState("");
  useEffect(() => {
    void refreshRequestProgress(approval.thread_id);
  }, [approval.id, approval.thread_id]);
  const act = async (action: string) => {
    setActing(true);
    setActError("");
    try {
      await actOnRequest(approval.id, action);
    } catch (e) {
      setActError(failed(e));
    } finally {
      setActing(false);
    }
  };
  const chip = { label: "macOS" };
  const well = (
    <Well
      rows={[
        { key: "App", value: input.app },
        ...(input.bundle_id || input.app_path ? [{ key: "Identity", value: (input.bundle_id ?? input.app_path)!, mono: true }] : []),
        { key: "Setting", value: input.pane_label },
      ]}
    />
  );
  const shown = actError || error || progress?.error || "";
  if (view === "done")
    return (
      <RequestCardShell>
        <RequestHeader icon="checkmark.circle" tone="positive" title={permissionGrantedTitle(input)} chip={chip} />
        <StatusLine done text={`${agent} is continuing.`} />
      </RequestCardShell>
    );
  const confirm = (
    <Button role="prominent" busy={acting} onPress={() => void act(input.detects ? "check" : "granted")}>
      {input.detects ? "Check again" : "I’ve turned it on"}
    </Button>
  );
  if (view === "wait")
    return (
      <RequestCardShell>
        <RequestHeader icon="display" title={permissionTitle(input)} chip={chip} />
        {well}
        <StatusLine text={permissionWaitingLine(input)} />
        <ErrorBanner error={shown} />
        <Actions>
          <Half>
            <Button disabled={acting} onPress={() => void act("stop")}>
              Stop waiting
            </Button>
          </Half>
          <Half>{confirm}</Half>
        </Actions>
      </RequestCardShell>
    );
  const off = view === "off";
  return (
    <RequestCardShell label={off ? permissionStillOffTitle(input) : permissionTitle(input)}>
      <RequestHeader
        icon="display"
        title={off ? permissionStillOffTitle(input) : permissionTitle(input)}
        chip={chip}
        meta={off ? permissionStillOffMeta(input) : input.reason ? `${agent}: “${input.reason}”` : undefined}
      />
      {well}
      {!off && (
        <T variant="footnote" tone="secondary">
          {`On your Mac, open System Settings › ${input.pane_label}${input.needs_app_added ? ` and add ${input.app} with +` : ""}, then turn on ${input.app}.${input.relaunch ? ` macOS applies it after ${input.app} restarts.` : ""}`}
        </T>
      )}
      <ErrorBanner error={shown} />
      <Actions>
        <Half>
          <Button role="destructive" disabled={busy} onPress={() => void decline()}>
            Decline
          </Button>
        </Half>
        <Half>{confirm}</Half>
      </Actions>
      <T variant="footnote" tone="muted">
        {`${permissionPane(input.pane).name} can only be turned on at the computer.`}
      </T>
    </RequestCardShell>
  );
}

// ---- point for me ----

/** Files and folders can be picked from the phone; elements, images and windows only on the computer. */
export function PickRequestCard({ approval, input }: { approval: ApprovalRequest; input: PickRequestInput }) {
  const agent = agentFor(approval.thread_id);
  const { busy, error, decline } = useDecline(approval);
  const browsable = input.kind === "file" || input.kind === "folder";
  return (
    <RequestCardShell label={pickTitle(input.kind, agent)}>
      <RequestHeader icon={browsable ? "folder" : "viewfinder"} title={pickTitle(input.kind, agent)} meta={input.prompt || undefined} />
      {browsable ? (
        <PickBrowser approval={approval} folder={input.kind === "folder"} />
      ) : (
        <T variant="footnote" tone="secondary">
          {isElementPick(input.kind)
            ? "Point to it in Kybern on your computer. The phone can’t point into a page."
            : input.kind === "window"
              ? "Choose the window on your computer."
              : "Drop the image in Kybern on your computer."}
        </T>
      )}
      <ErrorBanner error={error} />
      <Button role="destructive" disabled={busy} onPress={() => void decline("Can’t do this from the phone.")}>
        {`Decline and tell ${agent}`}
      </Button>
    </RequestCardShell>
  );
}

/** A small tree of the project's files: tap a folder to open it, then pick. */
function PickBrowser({ approval, folder }: { approval: ApprovalRequest; folder: boolean }) {
  const { colors } = useTheme();
  const projectId = getState().threads.find((thread) => thread.id === approval.thread_id)?.project_id;
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setEntries(null);
    rpc("files.list", { project_id: projectId, path })
      .then((result) => {
        if (alive) setEntries(result.entries);
      })
      .catch((e) => {
        if (alive) setError(failed(e));
      });
    return () => {
      alive = false;
    };
  }, [projectId, path]);
  const pick = async (picked: string) => {
    setBusy(true);
    setError("");
    try {
      await respondApproval(approval, { decision: "submit", response: { path: picked || "." } });
      haptics.success();
    } catch (e) {
      setError(failed(e));
      setBusy(false);
    }
  };
  const shown = (entries ?? []).filter((entry) => !folder || entry.kind === "directory").slice(0, 60);
  return (
    <View style={{ borderRadius: radius.md, backgroundColor: colors.raised, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, minHeight: 44 }}>
        {!!path && (
          <Tap label="Up one folder" onPress={() => setPath(path.split("/").slice(0, -1).join("/"))} style={{ alignItems: "center" }}>
            <Icon name="chevron.left" size={16} color={colors.accent} />
          </Tap>
        )}
        <T variant="code" tone="secondary" numberOfLines={1} ellipsizeMode="head" style={{ flex: 1 }}>
          {path || "Project folder"}
        </T>
        {folder && (
          <Button size="medium" role="plain" disabled={busy} onPress={() => void pick(path)}>
            Use this folder
          </Button>
        )}
      </View>
      {entries === null && !error ? (
        <T variant="footnote" tone="muted" style={{ paddingHorizontal: space.md, paddingBottom: space.md }}>
          Loading…
        </T>
      ) : (
        shown.map((entry) => (
          <Tap
            key={entry.name}
            label={entry.kind === "directory" ? `Open ${entry.name}` : `Pick ${entry.name}`}
            feedback="highlight"
            disabled={busy}
            onPress={() => (entry.kind === "directory" ? setPath(entry.path) : void pick(entry.path))}
            style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, minHeight: 44, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}
          >
            <Icon name={entry.kind === "directory" ? "folder" : "doc"} size={17} color={colors.secondary} />
            <T variant="code" numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1 }}>
              {entry.name}
            </T>
            {entry.kind === "directory" && <Icon name="chevron.right" size={12} color={colors.muted} />}
          </Tap>
        ))
      )}
      <ErrorBanner error={error} />
    </View>
  );
}

// ---- records ----

const RECORD_ICONS: Record<RequestRecord["glyph"], IconName> = {
  lock: "lock",
  key: "key",
  shield: "lock.shield",
  cross: "xmark.circle",
  clock: "clock",
  service: "key",
  app: "display",
  check: "checkmark.circle",
  question: "text.bubble",
};

/** The one quiet line a settled card leaves: what happened, never a secret. */
export function RequestRecordLine({ record, children }: { record: RequestRecord; children?: ReactNode }) {
  const { colors } = useTheme();
  const tint = record.tone === "done" ? colors.positive : colors.muted;
  return (
    <View style={{ gap: space.xs }} accessibilityLabel={recordText(record)}>
      <View style={{ flexDirection: "row", gap: space.sm, minHeight: 28, alignItems: "flex-start", paddingTop: space.xs }}>
        <Icon name={RECORD_ICONS[record.glyph]} size={14} color={tint} />
        <T variant="footnote" tone="secondary" style={{ flex: 1 }}>
          {record.parts.map((part, i) =>
            part.code ? (
              <Text key={i} style={{ fontFamily: MONO }}>
                {part.text}
              </Text>
            ) : part.strong ? (
              <Text key={i} style={{ color: colors.ink, fontWeight: "500" }}>
                {part.text}
              </Text>
            ) : (
              part.text
            ),
          )}
          {record.detail ? <Text style={{ color: colors.muted }}>{` · ${record.detail}`}</Text> : null}
        </T>
      </View>
      {children}
    </View>
  );
}

/** A plain settled line: an icon and one sentence (approvals, picks, visual answers). */
export function SettledLine({ icon, text, tone = "secondary" }: { icon: IconName; text: string; tone?: "secondary" | "positive" | "negative" }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: space.sm, minHeight: 28, alignItems: "center" }}>
      <Icon name={icon} size={14} color={tone === "positive" ? colors.positive : tone === "negative" ? colors.negative : colors.muted} />
      <T variant="footnote" tone="secondary" style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  );
}
