import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/synara/button"
import { Input } from "@/components/synara/input"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "@/components/synara/dialog"
import { ComposerPickerMenuPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/synara/menu"
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  GlobeIcon,
  PencilIcon,
  Plus,
  SettingsIcon,
  Trash2,
} from "@/lib/synara/icons"
import { Spinner } from "@/components/kybern/bits"
import type { EnvironmentProfile } from "@/lib/environments"
import {
  parsePairingInvitation,
  pairingInvitation,
  normalizeDaemonUrl,
} from "../../../../packages/kybern-client/src/address"
import {
  activeEnvironment,
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
  const [name, setName] = useState(profile?.name ?? "")
  const [address, setAddress] = useState(profile?.url ?? "")
  const [code, setCode] = useState("")
  const [expectedIdentity, setExpectedIdentity] = useState<string | undefined>(
    undefined
  )
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
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
      setError(
        /error sending request|connection refused|timed out/i.test(detail)
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
                {profile.url ?? profile.hostname ?? "Managed by Kybern"}
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
