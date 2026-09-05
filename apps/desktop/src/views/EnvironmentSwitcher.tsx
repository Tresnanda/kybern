import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/kit/button"
import { Input } from "@/components/kit/input"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "@/components/kit/dialog"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/kit/menu"
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  GlobeIcon,
  PencilIcon,
  Plus,
  SettingsIcon,
  Trash2,
} from "@/lib/kit/icons"
import { Spinner } from "@/components/kybern/bits"
import {
  listSshHosts,
  type BootstrapProgress,
  type BootstrapStep,
  type EnvironmentProfile,
} from "@/lib/environments"
import { isTauri } from "@/lib/tauri"
import {
  parsePairingInvitation,
  pairingInvitation,
  normalizeDaemonUrl,
} from "../../../../packages/kybern-client/src/address"
import {
  activeEnvironment,
  bootstrapAndConnectRemote,
  forgetEnvironment,
  saveAndConnectEnvironment,
  switchEnvironment,
  useEnvironments,
} from "@/state/environments"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"
import type { PairingCreateResult, TokenInfo } from "@/protocol"
import {
  ENVIRONMENT_DIALOG,
  ENVIRONMENT_HINT,
  ENVIRONMENT_ERROR,
} from "./environmentStyles"

const FIELD = "flex flex-col gap-1.5"
const BOOTSTRAP_STEPS: { id: BootstrapStep; label: string }[] = [
  { id: "connect", label: "Connect over SSH" },
  { id: "install", label: "Install kybernd" },
  { id: "start", label: "Start the daemon" },
  { id: "pair", label: "Pair this device" },
]

export function EnvironmentSwitcher() {
  const profiles = useEnvironments((s) => s.profiles)
  const selectedId = useEnvironments((s) => s.selectedId)
  const switching = useEnvironments((s) => s.switching)
  const connection = useStore((s) => s.connection)
  const info = useStore((s) => s.info)
  const profile = profiles.find((p) => p.id === selectedId)
  const [dialog, setDialogContent] = useState<"add" | "manage" | "access">(
    "add"
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  const setDialog = (next: "add" | "manage" | "access") => {
    setDialogContent(next)
    setDialogOpen(true)
  }
  const [editing, setEditing] = useState<EnvironmentProfile | null>(null)
  const canManageAccess =
    info?.scopes.includes("access_write") && connection.state === "open"
  const statusLabel =
    switching || connection.state === "connecting"
      ? "Connecting"
      : connection.state === "open"
        ? "Connected"
        : connection.state === "reconnecting"
          ? "Reconnecting"
          : "Offline"

  return (
    <>
      <div className="px-2 pb-1.5">
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Switch environment"
                aria-description={`${profile?.name ?? "Environment"}, ${statusLabel}`}
                title={`${profile?.name ?? "Environment"} · ${statusLabel}`}
                className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-start text-[length:var(--app-font-size-ui,14px)] text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.96] active:bg-sidebar-accent motion-reduce:active:scale-100"
              />
            }
          >
            {switching ? (
              <Spinner size={14} />
            ) : (
              <GlobeIcon className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate text-foreground">
              {profile?.name ?? "Connecting"}
            </span>
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${connection.state === "open" ? "bg-emerald-500" : connection.state === "failed" ? "bg-destructive" : "bg-muted-foreground/40"}`}
            />
            <span className="sr-only">{`${profile?.name ?? "Environment"}, ${statusLabel}`}</span>
            <ChevronDownIcon className="size-3" />
          </MenuTrigger>
          <ComposerPickerMenuPopup
            align="start"
            side="bottom"
            className="w-72 min-w-64 transition-[opacity,scale] duration-150 ease-out data-ending-style:scale-99 data-ending-style:opacity-0 data-starting-style:scale-97 data-starting-style:opacity-0 motion-reduce:transition-none"
          >
            <MenuGroup>
              <MenuGroupLabel>Environments</MenuGroupLabel>
              {profiles.map((item) => (
                <MenuItem
                  key={item.id}
                  className="items-start [&>svg]:mt-0.5"
                  onClick={() => {
                    if (item.id !== selectedId || connection.state === "failed")
                      void switchEnvironment(item.id)
                  }}
                >
                  <GlobeIcon className="size-3.5" />
                  <span className="min-w-0 flex-1 leading-normal break-words whitespace-normal">
                    <bdi>{item.name}</bdi>
                    {item.id === selectedId && (
                      <span className="block text-[length:var(--app-font-size-ui-sm,13px)] font-normal text-muted-foreground">
                        {statusLabel}
                      </span>
                    )}
                  </span>
                  {item.id === selectedId && <CheckIcon className="size-3.5" />}
                </MenuItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuItem
                onClick={() => {
                  setEditing(null)
                  setDialog("add")
                }}
              >
                <Plus /> Add environment
              </MenuItem>
              <MenuItem onClick={() => setDialog("manage")}>
                <SettingsIcon /> Manage environments
              </MenuItem>
              <MenuItem
                disabled={!canManageAccess}
                onClick={() => setDialog("access")}
              >
                <GlobeIcon /> Pair a device
              </MenuItem>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className={ENVIRONMENT_DIALOG}>
          {dialog === "add" ? (
            <EnvironmentForm
              profile={editing}
              onDone={() => setDialogOpen(false)}
            />
          ) : dialog === "manage" ? (
            <ManageEnvironments
              onEdit={(item) => {
                setEditing(item)
                setDialog("add")
              }}
            />
          ) : dialog === "access" ? (
            <DeviceAccess />
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  )
}

function EnvironmentForm({
  profile,
  onDone,
}: {
  profile: EnvironmentProfile | null
  onDone: () => void
}) {
  const sshAvailable = isTauri()
  const [mode, setMode] = useState<"ssh" | "address">(
    sshAvailable && (!profile || profile.ssh) ? "ssh" : "address"
  )
  const [busy, setBusy] = useState(false)
  const chooser = !profile && sshAvailable && (
    <div
      role="tablist"
      aria-label="How to reach the machine"
      className="flex gap-1 rounded-lg bg-secondary/60 p-1"
    >
      {(
        [
          ["ssh", "Over SSH"],
          ["address", "Address or invitation"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={mode === id}
          disabled={busy}
          onClick={() => setMode(id)}
          className={`flex-1 rounded-md px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,13px)] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60 ${mode === id ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
  return mode === "ssh" ? (
    <SshEnvironmentForm
      profile={profile}
      onDone={onDone}
      chooser={chooser}
      busy={busy}
      setBusy={setBusy}
    />
  ) : (
    <AddressEnvironmentForm
      profile={profile}
      onDone={onDone}
      chooser={chooser}
      busy={busy}
      setBusy={setBusy}
    />
  )
}

function SshEnvironmentForm({
  profile,
  onDone,
  chooser,
  busy,
  setBusy,
}: {
  profile: EnvironmentProfile | null
  onDone: () => void
  chooser: React.ReactNode
  busy: boolean
  setBusy: (busy: boolean) => void
}) {
  const [name, setName] = useState(profile?.name ?? "")
  const [target, setTarget] = useState(
    profile?.ssh
      ? profile.ssh.port
        ? `${profile.ssh.target}:${profile.ssh.port}`
        : profile.ssh.target
      : ""
  )
  const [dataDir, setDataDir] = useState(profile?.ssh?.data_dir ?? "")
  const [hosts, setHosts] = useState<string[]>([])
  const [steps, setSteps] = useState<
    Partial<Record<BootstrapStep, BootstrapProgress>>
  >({})
  const [error, setError] = useState<string | null>(null)
  const started = Object.keys(steps).length > 0
  useEffect(() => {
    let cancelled = false
    void listSshHosts().then((found) => {
      if (!cancelled) setHosts(found)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSteps({})
    let current: BootstrapStep = "connect"
    try {
      await bootstrapAndConnectRemote(
        {
          id: profile?.id,
          name,
          target,
          data_dir: dataDir.trim() || undefined,
        },
        (progress) => {
          if (progress.step === "failed") {
            setSteps((previous) => ({
              ...previous,
              [current]: { step: current, state: "failed", detail: progress.detail },
            }))
            return
          }
          current = progress.step
          setSteps((previous) => ({ ...previous, [progress.step]: progress }))
        }
      )
      onDone()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const host = target.trim().replace(/^ssh:\/\//, "").replace(/^[^@]*@/, "")
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>
          {profile ? "Edit environment" : "Add environment"}
        </DialogTitle>
        <DialogDescription>
          Kybern signs in with your SSH keys, installs and starts the daemon on
          that machine, and pairs this device through a tunnel it keeps open.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4 pt-3">
        {chooser}
        <label className={FIELD}>
          <span className={dialogFieldLabelClassName}>Name</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dev server"
            maxLength={80}
            required
            disabled={busy}
          />
        </label>
        <label className={FIELD}>
          <span className={dialogFieldLabelClassName}>Machine</span>
          <Input
            value={target}
            aria-label="SSH machine"
            dir="ltr"
            list="kybern-ssh-hosts"
            onChange={(e) => setTarget(e.target.value)}
            placeholder="user@host"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            disabled={busy}
          />
          <datalist id="kybern-ssh-hosts">
            {hosts.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </label>
        <p className={ENVIRONMENT_HINT}>
          Anything that works with <code className="font-mono">ssh</code>{" "}
          works here, including aliases from ~/.ssh/config and a custom port
          as host:port. Key or agent sign-in is required; passwords are never
          asked for.
        </p>
        <details className={ENVIRONMENT_HINT}>
          <summary className="w-fit cursor-pointer rounded-md py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring">
            Advanced
          </summary>
          <label className={`${FIELD} mt-3`}>
            <span className={dialogFieldLabelClassName}>
              Data directory on that machine (optional)
            </span>
            <Input
              value={dataDir}
              dir="ltr"
              onChange={(e) => setDataDir(e.target.value)}
              placeholder="~/.kybern"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
        </details>
        {started && (
          <ol
            aria-label="Setup progress"
            className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
          >
            {BOOTSTRAP_STEPS.map((step) => {
              const state = steps[step.id]?.state ?? "pending"
              return (
                <li key={step.id} className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                    {state === "running" ? (
                      <Spinner size={13} />
                    ) : state === "done" ? (
                      <CheckIcon className="size-3.5 text-emerald-500" />
                    ) : state === "failed" ? (
                      <span
                        aria-hidden="true"
                        className="size-2 rounded-full bg-destructive"
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-muted-foreground/40"
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[length:var(--app-font-size-ui-sm,13px)] leading-snug ${state === "pending" ? "text-muted-foreground" : "text-foreground"}`}
                    >
                      {step.label}
                      <span className="sr-only">
                        {state === "running"
                          ? ", in progress"
                          : state === "done"
                            ? ", done"
                            : state === "failed"
                              ? ", failed"
                              : ""}
                      </span>
                    </span>
                    {steps[step.id]?.detail && state !== "failed" && (
                      <span className={`${ENVIRONMENT_HINT} block break-words`}>
                        {steps[step.id]?.detail}
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
        {error && (
          <p role="alert" className={ENVIRONMENT_ERROR}>
            {error}
            {/Permission denied|ssh-copy-id/.test(error) && host && (
              <span className="mt-1 block font-mono text-[length:var(--app-font-size-ui-sm,13px)] text-foreground select-text">
                ssh-copy-id {target.trim()}
              </span>
            )}
          </p>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button
          type="submit"
          disabled={busy || !name.trim() || !target.trim()}
        >
          {busy && <Spinner size={13} />}
          {busy
            ? "Setting up"
            : profile
              ? "Set up again and connect"
              : "Set up and connect"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function AddressEnvironmentForm({
  profile,
  onDone,
  chooser,
  busy,
  setBusy,
}: {
  profile: EnvironmentProfile | null
  onDone: () => void
  chooser: React.ReactNode
  busy: boolean
  setBusy: (busy: boolean) => void
}) {
  const [name, setName] = useState(profile?.name ?? "")
  const [address, setAddress] = useState(profile?.url ?? "")
  const [code, setCode] = useState("")
  const [expectedIdentity, setExpectedIdentity] = useState<string | undefined>(
    undefined
  )
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [addressError, setAddressError] = useState<string | null>(null)
  const validateAddress = () => {
    try {
      normalizeDaemonUrl(address)
      setAddressError(null)
      return true
    } catch {
      setAddressError(
        "Enter a machine address, such as https://machine.example.ts.net."
      )
      return false
    }
  }
  const setAddressOrInvitation = (value: string) => {
    setAddressError(null)
    const invitation = parsePairingInvitation(value)
    if (invitation) {
      setAddress(invitation.url)
      setCode(invitation.code)
      setToken("")
      setExpectedIdentity(invitation.environmentId)
    } else {
      setAddress(value)
      setExpectedIdentity(undefined)
    }
  }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!validateAddress()) return
    setBusy(true)
    setError(null)
    try {
      await saveAndConnectEnvironment({
        id: profile?.id,
        name,
        url: address,
        code: code || undefined,
        token: token || undefined,
        expected_environment_id: expectedIdentity,
      })
      onDone()
    } catch (e) {
      const detail = errorText(e)
      const unreachable = /error sending request|connection refused|timed out/i.test(detail)
      setError(
        unreachable && isLoopbackAddress(address)
          ? "This invitation points at the other machine's own loopback address, which only works on that machine. For a daemon that listens on 127.0.0.1, add it over SSH instead, or bind it to an address this device can reach."
          : unreachable
            ? "Unable to reach this machine. Check its address and network connection, then try again."
            : detail
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>
          {profile ? "Edit environment" : "Add environment"}
        </DialogTitle>
        <DialogDescription>
          Switch between machines. Each keeps its own projects and threads.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4 pt-3">
        {chooser}
        <label className={FIELD}>
          <span className={dialogFieldLabelClassName}>Name</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dev server"
            maxLength={80}
            required
            disabled={busy}
          />
        </label>
        <label className={FIELD}>
          <span className={dialogFieldLabelClassName}>
            Address or pairing invitation
          </span>
          <Input
            value={address}
            aria-label="Address or pairing invitation"
            dir="ltr"
            onBlur={() => {
              if (address.trim()) validateAddress()
            }}
            aria-invalid={!!addressError}
            aria-describedby={
              addressError ? "environment-address-error" : undefined
            }
            onChange={(e) => setAddressOrInvitation(e.target.value)}
            placeholder="https://machine.example.ts.net"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            disabled={busy}
          />
          {addressError && (
            <span
              id="environment-address-error"
              role="alert"
              className={ENVIRONMENT_ERROR}
            >
              {addressError}
            </span>
          )}
        </label>
        <label className={FIELD}>
          <span className={dialogFieldLabelClassName}>
            Pairing code{profile ? " (optional)" : ""}
          </span>
          <Input
            value={code}
            dir="ltr"
            className="font-mono tracking-widest tabular-nums"
            aria-describedby="environment-pairing-help"
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              setToken("")
            }}
            placeholder="000000"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            disabled={busy}
          />
        </label>
        <p id="environment-pairing-help" className={ENVIRONMENT_HINT}>
          {profile
            ? "Leave the code empty to keep this device’s access."
            : "On the other machine, choose Pair a device in the environment menu. For a server or VPS, run kybern pair over SSH."}
        </p>
        <details className={ENVIRONMENT_HINT}>
          <summary className="w-fit cursor-pointer rounded-md py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring">
            Use an existing device token
          </summary>
          <label className={`${FIELD} mt-3`}>
            <span className={dialogFieldLabelClassName}>Device token</span>
            <Input
              type="password"
              aria-label="Device token"
              value={token}
              onChange={(e) => {
                setToken(e.target.value)
                setCode("")
              }}
              autoComplete="off"
              placeholder="Device token"
              disabled={busy}
            />
          </label>
        </details>
        {error && (
          <p role="alert" className={ENVIRONMENT_ERROR}>
            {error}
          </p>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button
          type="submit"
          disabled={
            busy ||
            !name.trim() ||
            !address.trim() ||
            (!profile && code.length !== 6 && !token.trim())
          }
        >
          {busy && <Spinner size={13} />}
          {busy ? "Connecting" : "Save and connect"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ManageEnvironments({
  onEdit,
}: {
  onEdit: (profile: EnvironmentProfile) => void
}) {
  const profiles = useEnvironments((s) => s.profiles)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <DialogHeader>
        <DialogTitle>Manage environments</DialogTitle>
        <DialogDescription>
          Edit a connection or remove it from this device. Work on that machine
          keeps running.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-1 pt-3">
        {profiles.map((profile) => (
          <div
            key={profile.id}
            className="flex items-start gap-3 rounded-lg py-3"
          >
            <GlobeIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-[length:var(--app-font-size-ui,14px)] leading-relaxed break-words">
                <bdi>{profile.name}</bdi>
              </div>
              <div
                dir="auto"
                className={`${ENVIRONMENT_HINT} break-all select-text`}
              >
                {profile.ssh
                  ? `ssh ${profile.ssh.port ? `${profile.ssh.target}:${profile.ssh.port}` : profile.ssh.target}`
                  : (profile.url ?? profile.hostname ?? "Managed by Kybern")}
              </div>
            </div>
            {profile.id !== "local" && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${profile.name}`}
                  disabled={!!busy}
                  onClick={() => onEdit(profile)}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${profile.name}`}
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(profile.id)
                    setError(null)
                    try {
                      await forgetEnvironment(profile.id)
                    } catch (e) {
                      setError(errorText(e))
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  {busy === profile.id ? (
                    <Spinner size={13} />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </Button>
              </>
            )}
          </div>
        ))}
        {error && (
          <p role="alert" className={ENVIRONMENT_ERROR}>
            {error}
          </p>
        )}
      </DialogPanel>
    </>
  )
}

function DeviceAccess() {
  const [invitation, setInvitation] = useState<PairingCreateResult | null>(null)
  const [address, setAddress] = useState("")
  const [devices, setDevices] = useState<TokenInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const info = useStore((s) => s.info)
  const profile = activeEnvironment()
  useEffect(() => {
    let active = true
    let loading = false
    const client = rpc()
    const refresh = () => {
      if (loading || client.status !== "open") return
      loading = true
      void client
        .call("access.tokens.list", {})
        .then((result) => {
          if (active) setDevices(result.tokens)
        })
        .catch((e) => {
          if (active) setError(errorText(e))
        })
        .finally(() => {
          loading = false
        })
    }
    refresh()
    const devicesTimer = setInterval(refresh, 5000)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      active = false
      clearInterval(timer)
      clearInterval(devicesTimer)
    }
  }, [])
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await rpc().call("access.pairing.create", {})
      setInvitation(next)
      setAddress(
        profile?.url ??
          next.endpoints.find(
            (url) => !url.includes("127.0.0.1") && !url.includes("[::1]")
          ) ??
          ""
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const expired = !!invitation && Date.parse(invitation.expires_at) <= now
  return (
    <>
      <DialogHeader>
        <DialogTitle>Pair a device</DialogTitle>
        <DialogDescription>
          Give another device access to {profile?.name ?? "this environment"}.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4 pt-3">
        {invitation && (
          <>
            <div className="rounded-xl bg-muted/40 px-4 py-4 text-center">
              <div
                dir="ltr"
                className="font-mono text-3xl tracking-[0.25em] tabular-nums select-text"
              >
                {invitation.code}
              </div>
              <div className={`mt-2 tabular-nums ${ENVIRONMENT_HINT}`}>
                {expired
                  ? "Code expired. Create a new invitation."
                  : `Use once before ${new Date(
                      invitation.expires_at
                    ).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`}
              </div>
            </div>
            <label className={FIELD}>
              <span className={dialogFieldLabelClassName}>
                Connection address
              </span>
              <Input
                value={address}
                dir="ltr"
                onChange={(e) => setAddress(e.target.value)}
                placeholder="https://machine.example.ts.net"
                spellCheck={false}
              />
            </label>
            {!address && (
              <p className={ENVIRONMENT_HINT}>
                Enter an address the other device can reach, such as your
                Tailscale HTTPS address or SSH tunnel address.
              </p>
            )}
            <Button
              variant="default"
              disabled={!address || expired}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    pairingInvitation(
                      address,
                      invitation.code,
                      info!.environment_id
                    )
                  )
                  toast("Copied pairing invitation")
                } catch (e) {
                  setError(errorText(e))
                }
              }}
            >
              <CopyIcon className="size-3.5" /> Copy invitation
            </Button>
          </>
        )}
        <Button
          variant={invitation && !expired ? "secondary" : "default"}
          onClick={() => void create()}
          disabled={busy}
        >
          {busy && <Spinner size={13} />}
          {invitation ? "Create new invitation" : "Create pairing invitation"}
        </Button>
        <div className="mt-4">
          <h3 className="mb-1 text-[length:var(--app-font-size-ui,14px)] font-medium">
            Paired devices
          </h3>
          {devices.filter((device) => device.label !== "bootstrap").length ===
            0 && (
            <p className={`py-2 ${ENVIRONMENT_HINT}`}>
              Create an invitation, then open it on the device you want to
              connect.
            </p>
          )}
          {devices
            .filter((device) => device.label !== "bootstrap")
            .map((device) => (
              <div key={device.id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1 text-[length:var(--app-font-size-ui-sm,13px)] leading-relaxed break-words">
                  <bdi>{device.label}</bdi>
                </span>
                {device.revoked ? (
                  <span className="text-xs text-muted-foreground">Revoked</span>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await rpc().call("access.tokens.revoke", {
                          token_id: device.id,
                        })
                        setDevices((all) =>
                          all.map((d) =>
                            d.id === device.id ? { ...d, revoked: true } : d
                          )
                        )
                      } catch (e) {
                        setError(errorText(e))
                      }
                    }}
                  >
                    Revoke access
                  </Button>
                )}
              </div>
            ))}
        </div>
        {error && (
          <p role="alert" className={ENVIRONMENT_ERROR}>
            {error}
          </p>
        )}
      </DialogPanel>
    </>
  )
}

/** True when the address names this device's own loopback interface. */
function isLoopbackAddress(address: string) {
  try {
    const host = new URL(address.trim()).hostname.replace(/^\[|\]$/g, "")
    return host === "localhost" || host === "::1" || /^127\./.test(host)
  } catch {
    return false
  }
}
