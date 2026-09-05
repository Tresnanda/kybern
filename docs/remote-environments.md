# Remote environments

An environment is one running Kybern daemon and its data directory. Normally
that means one machine. It owns its projects, threads, agent processes, files,
Git worktrees, terminals, settings, provider credentials, and queued messages.
The desktop and phone connect to that environment as clients.

```text
Desktop or phone
  ├─ Machine A → kybernd → projects A–C, threads, agents, terminals
  └─ Machine B → kybernd → projects D–F, threads, agents, terminals
```

The desktop environment menu switches the entire workspace. Selecting Machine B
shows only B's projects and work. Drafts, selected threads, split panes and dock
state are remembered separately for each environment. Switching or closing a
client leaves accepted work running on its host. A remote outage never redirects
an action to the local machine.

## Connect another desktop

### Over SSH (recommended)

If you can `ssh user@host` to the machine with a key or agent, the desktop does
the rest. Choose **Switch environment → Add environment → Over SSH**, enter a
name and `user@host` (an alias from `~/.ssh/config` or `host:port` also work),
and choose **Set up and connect**. Kybern then, over that SSH connection:

1. checks the machine and installs `kybernd` and `kybern` from the latest
   release when they are missing (`curl` is required there);
2. starts the daemon on the remote loopback, as a systemd user service where
   one exists (with lingering, so it survives logout and reboot) and detached
   with `nohup` elsewhere;
3. opens a port-forward tunnel from a loopback port on the desktop to the
   daemon, reads the daemon's bootstrap token to mint a one-time pairing code,
   and pairs this device with it like any other client.

The saved environment keeps the SSH target. Opening it reopens the tunnel, and
a tunnel that drops (sleep, network change) is respawned on the same local
port with backoff, so the client reconnects on its own. Passwords are never
prompted for; a machine that needs one fails with the `ssh-copy-id` command to
run first. **Advanced** sets the daemon's data directory on that machine when it
is not `~/.kybern`. Removing the environment closes the tunnel and forgets the
credential; the daemon on the machine keeps running.

Agent CLIs still need to be installed and signed in on that machine; open a
terminal there from Kybern to run `claude login` or the equivalent.

### By address or invitation

1. Install `kybernd`, the desired coding-agent CLIs, and their credentials on
   the machine that will run the work. Install `kybern` there for headless setup.
2. Make the daemon reachable using one of the network options below.
3. On that machine, open **Switch environment → Pair a device → Create pairing
   invitation**, or run `kybern pair` over SSH. With only the daemon installed,
   start it with `kybernd --pair` to print the same code and invitations.
   When using a custom data directory, pass
   the same `--data-dir` to both binaries.
4. On the connecting desktop, choose **Switch environment → Add environment**.
   Give it a name, paste its address and six-digit code, then save. You can also
   paste the complete invitation into the address field.

Codes expire after ten minutes and work once. Create a code for each device.
The invitation contains the address, code and environment identity; it contains
no long-lived credential. Its address must be reachable **from the receiving
device**. An SSH tunnel address, for example, belongs to the receiving desktop.

Saved connections appear in the environment menu on subsequent launches. Use
**Manage environments** to rename, change an address, re-pair, or forget one.
Changing an address must still reach the same environment identity. Add a
different environment separately.

## Network options

Kybern accepts an existing reachable endpoint. It does not provision a VPN,
relay, TLS certificate, SSH tunnel, or firewall rule.

### Tailscale with HTTPS

Install and connect Tailscale on the host and clients. On the host, use
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) to
forward HTTPS to the daemon's loopback listener:

```sh
kybernd --bind 127.0.0.1 --port 4173
```

In another shell:

```sh
tailscale serve --bg http://127.0.0.1:4173
kybern pair
```

`kybern pair` detects a running Tailscale HTTPS Serve proxy that forwards to
this daemon and prints its address and complete invitation. Paste the invitation
into Add environment. Use `--advertise-url` for a proxy discovery cannot inspect. Tailscale Serve must
have HTTPS enabled for the tailnet. Its background mode persists the proxy;
run `kybernd` under your host's service manager if it should start after reboot.

`--advertise-url` (or `KYBERN_ADVERTISE_URL`) controls the address included in
pairing invitations. It does not change the bind address or configure TLS.

### SSH tunnel

Keep the host daemon on loopback at a stable port:

```sh
kybernd --bind 127.0.0.1 --port 4173
kybern pair
```

On the connecting desktop:

```sh
ssh -N -L 14173:127.0.0.1:4173 user@machine
```

Enter `http://127.0.0.1:14173` and the host's pairing code in Add environment.
Keep the tunnel running while connected. The pinned environment identity
prevents a reused tunnel port from opening a different machine's workspace.

### Private network interface

Bind to the host's reachable private address, such as its Tailscale IP:

```sh
kybernd --bind 100.101.102.103 --port 4173 \
  --advertise-url ws://100.101.102.103:4173/ws
kybern pair
```

Use that address from a connected client. Plain `ws`/`http` relies on the
network or tunnel for encryption; use HTTPS when that protection is absent.
`--bind 0.0.0.0` listens on every IPv4 interface, so an explicit private address
is preferable. IPv6 addresses are supported, including bracketed client URLs.

A reverse proxy must forward `/ws` with WebSocket upgrades and `/session`,
`/pair`, and `/assets` HTTP requests. An optional URL prefix is supported on
clients when the proxy strips it before forwarding. Avoid logging authorization
headers, pairing bodies, or WebSocket ticket query strings.

## Address discovery and invitation output

`kybern pair` refreshes address discovery on the host each time it creates a
code. `kybernd --pair` does the same at startup, then keeps serving. Both print
the six-digit code, its full UTC expiry, addresses ready for the desktop input,
and complete `kybern://pair?...` invitations with the environment identity.
The CLI's `--json` output contains `code`, `expires_at`, `environment_id`, and
`addresses` (each with `address`, `kind`, and `invitation`). Treat this output
as a temporary access credential.

Discovery uses active interfaces (`ip` with `ifconfig` fallback on Linux,
`ifconfig` on macOS, PowerShell on Windows) and the installed Tailscale CLI.
On minimal Linux images, install `iproute2` if neither network tool is present.
Commands have bounded timeouts; missing tools or a stopped Tailscale daemon
do not prevent creating a pairing code.

- **Tailscale HTTPS:** a running node's Serve configuration must have a root
  HTTPS proxy targeting this listener and port. Background and foreground Serve
  configurations are supported. A node's DNS name alone does not imply HTTPS.
- **Direct addresses:** only active IPs covered by the bound listener are listed.
  Tailscale IPs are preferred over other direct interfaces. Public IPv4 and IPv6
  assigned to the VPS are detected alongside private addresses. IPv6 link-local
  addresses are excluded because they require a client-specific interface zone.
- **Loopback:** a daemon bound to `127.0.0.1` does not advertise unrelated public
  or Tailscale interface IPs. Without a matching proxy, output explicitly says
  the address is local-only and explains the SSH/proxy next step.
- **NAT, proxies, firewalls:** discovery does not contact a public IP lookup
  service, infer inbound NAT mappings, open ports, or configure TLS. Configure
  the route first. For another proxy, a custom path prefix, or an address known
  only from the receiving device, provide the address explicitly.

Override the invitation's address without changing an already-running daemon:

```sh
kybern pair --address https://kybern.example.com
kybern pair --address http://127.0.0.1:14173   # receiving desktop's SSH tunnel
kybern pair --json
```

`--address` changes the generated invitation only; the CLI still connects to
its local daemon. `kybernd --advertise-url` persists the advertised choice for
that daemon process and takes precedence over automatic discovery. Keep using
HTTPS or an encrypted private network/tunnel for remote credentials and work.

## Keep a VPS running after logout and reboot

On a Linux VPS with systemd, run Kybern as the same ordinary user who owns the
projects and authenticated agent CLIs. The release installer does all of this
in one step:

```sh
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/Tresnanda/kybern/releases/latest/download/kybern-remote-install.sh | sh -s -- --service
```

It installs the daemon and CLI as described in the
[README](../README.md#daemon-only-vps-or-remote-machine), writes the unit
below, enables it, and prints the remaining steps. Stop a foreground daemon with
Ctrl+C before starting the service. To set it up by hand instead, create
`~/.config/systemd/user/kybernd.service` (create its parent directory if
needed):

```ini
[Unit]
Description=Kybern agent daemon

[Service]
ExecStart=%h/.cargo/bin/kybernd --bind 127.0.0.1 --port 4173
WorkingDirectory=%h
Environment="PATH=%h/.cargo/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

Adjust the binary location if you use a custom Cargo install root. Include the
actual directories of your agent executables, Node version manager, and
Tailscale CLI in `PATH`; a service does not load your interactive shell setup.
The example retains `~/.kybern` and loopback networking for Tailscale Serve or
another local HTTPS proxy. Add `--advertise-url` for an explicit proxy address.
Do not add `--pair` to the service: create invitations when needed over SSH.

```sh
systemctl --user daemon-reload
systemctl --user enable --now kybernd
sudo loginctl enable-linger "$USER"
kybern pair
```

[Lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)
keeps the user service manager running after logout and starts it at boot.
Inspect logs with `journalctl --user -u kybernd -f`; stop the daemon with
`systemctl --user stop kybernd`. Stopping or restarting the daemon ends its
agent processes and terminals; merely disconnecting a desktop or phone does not.

## Working in an environment

- **Projects:** Add project browses the selected host's folders. Paths, Git
  commands, agent executables and provider configuration all belong to that
  host. Local file-manager actions are unavailable for remote paths. Adding a
  project on B does not copy it from A.
- **Attachments:** selected client files upload to the selected host. Switching
  aborts unfinished uploads; a late response cannot change the next workspace.
- **Terminals:** disconnecting detaches the client. Returning reattaches to the
  same daemon-owned terminal and its bounded scrollback. A daemon restart ends
  its PTYs; the client shows that the terminal ended instead of silently rerunning
  a command.
- **Queued messages:** a successful queue acknowledgement means the daemon
  persisted the message. It runs queued messages in order once the thread is
  idle, including while every client is disconnected. A failed turn or a daemon
  restart during a turn pauses the queue. Send a new message to resume; after a
  successful completion, remaining queued messages continue. Archived threads
  discard pending messages. Queue IDs provide durable deduplication, including
  after consumption or cancellation.
- **Offline:** draft text and workspace layout remain on the client. Mutations
  require a live connection. A request whose acknowledgement was lost is not
  automatically replayed: reconnect and inspect the result before retrying.
  Sleeping or powered-off hosts cannot run work.
- **Reconnect:** one client transport owns retry timing, heartbeat checks,
  authentication and cursor replay. Returning from background checks liveness.
  Revoked credentials and incompatible identities stop retries and show an
  actionable error. Restoring an older host database requires restarting the
  client to discard its in-memory event history.

The CLI also supports `--url` plus `KYBERN_TOKEN` or `--token` for an explicitly
supplied device credential. It never sends the local bootstrap credential to
an explicitly configured remote URL. Remote project paths should be absolute
or start with `~/`; project names and IDs resolve on that host. `kybern queue
list`, `queue add`, and `queue remove` inspect and operate the host's queue.

## Trust and storage

The host creates a stable `environment_id` in its data directory. The native
client verifies it before saving or opening a connection, and the shared
transport checks it on every reconnect. Two data directories on one physical
machine are two environments. Copies of a data directory retain its identity;
create a fresh data directory for an independent environment.

Desktop connection metadata lives in the Tauri app config directory's
`environments.json`. `KYBERN_CLIENT_CONFIG_DIR` overrides that directory for
testing. Device credentials live in macOS Keychain, Windows Credential Manager,
or Linux Secret Service. A Linux desktop needs an available, unlocked Secret
Service; Kybern does not fall back to plaintext credential storage. Drafts and
workspace layout live in WebView storage under the verified environment ID.

The host stores hashes of client tokens. Each paired client receives the four
client scopes for orchestration, terminals and review; it cannot create more
pairings or administer access. On the host, **Pair a device** lists devices and
can revoke them. Revocation closes existing authenticated sockets as well as
rejecting future requests. Forgetting a saved connection only removes the
client's record; use host-side revocation to invalidate that device's access.

Desktop and mobile exchange their credential over HTTP for a short-lived,
single-use WebSocket ticket. Only that ticket enters the upgrade URL. A ticket
expires after 30 seconds and cannot be redeemed after its token is revoked.
The Rust CLI can authenticate the upgrade with an Authorization header.

## Mobile foundation

The existing Expo screens now use the same transport, wire types, URL handling,
pairing invitation format and identity checks as desktop. Pairing stores the
credential and pinned identity in SecureStore. App foregrounding checks the
connection, and reconnects replay missed events. See
[the mobile README](../apps/mobile/README.md) for running it.

The mobile app remains the existing companion scaffold with one saved endpoint.
A full mobile environment picker, notification delivery and companion UI are
separate product work. The host and shared client contracts support them
without moving execution onto the phone.

## Implementation and verification

`packages/kybern-client` owns the shared TypeScript protocol and connection
runtime. Desktop `state/environments.ts` selects a saved endpoint and creates a
runtime with a captured environment store; every environment surface remounts
on selection. Async actions retain their originating client and store.
`src-tauri/src/environments.rs` owns registry persistence, native validation and
credentials. The Rust daemon owns pairing, event delivery, queues and PTYs.

Regression coverage includes two independent host servers, host folder browsing,
single-use pairing and tickets, immediate revocation, ordered replay across a
large backlog, durable queue receipts, terminal reattachment, identity mismatch,
mutation interruption, replay deduplication and workspace isolation. Run:

```sh
cargo test --workspace --lib --bins
cargo test -p kybern-protocol
cargo clippy --workspace --all-targets -- -D warnings
cd apps/desktop
pnpm test
pnpm lint
pnpm build
```

The connection ownership model was cross-checked against
[T3 Code](https://github.com/pingdotgg/t3code). Kybern keeps its existing
daemon/protocol architecture and Synara components.
