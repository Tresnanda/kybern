# Kybern

Kybern is a desktop app for working with coding agents. You run Claude Code,
Codex, OpenCode, Cursor, pi and Oh My Pi side by side, each in its own thread,
and Kybern keeps a record of what each one ran and changed. Agents can hand work to each other, run in their own
git worktrees, and keep working while you're away from the desk.

It runs on macOS, Windows and Linux, with a companion app for Android and
iPhone. The agents run on your machine (or a server you choose); Kybern talks
to each one through its own protocol instead of wrapping a terminal.

Kybern is inspired by [T3 Code](https://github.com/pingdotgg/t3code) and
[Synara](https://github.com/Emanuele-web04/synara).

## Install

You need at least one agent installed and signed in on the same machine, for
example the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or
Codex CLI. Kybern finds the ones you have.

### macOS

Apple Silicon and Intel. One command installs Kybern into Applications and
opens it:

```sh
curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-mac-install.sh | sh
```

You can also download `kybern-gpuix_<version>_aarch64.app.tar.gz` (Apple
Silicon) or `_x86_64.app.tar.gz` (Intel) from the
[latest release](https://github.com/Tresnanda/kybern/releases/latest). Kybern
isn't notarized by Apple yet, so a copy downloaded in the browser is blocked the
first time with "Apple could not verify Kybern is free of malware". Allow it
once:

1. Click **Done** on that dialog (not Move to Trash).
2. Open **System Settings → Privacy & Security**, scroll to **Security** and
   click **Open Anyway** next to the message about Kybern.

   ![Open Anyway in Privacy & Security](assets/readme/gatekeeper-open-anyway.png)

3. Confirm with **Open Anyway** and your password or Touch ID.

   ![Confirm opening Kybern](assets/readme/gatekeeper-confirm.png)

The install command above skips this step, and so do updates.

### Windows

Windows 10 (1809 or later) and Windows 11, x64. Download
`kybern-gpuix_<version>_x64-setup.exe` from the
[latest release](https://github.com/Tresnanda/kybern/releases/latest) and run
it. It installs for your user only, so there's no administrator prompt. The
installer isn't signed yet, so SmartScreen warns once. Choose **More info →
Run anyway**.

### Linux

x86_64, on distributions with glibc 2.35 or newer: Ubuntu 22.04+, Debian 12+,
Fedora 36+, openSUSE Leap 16 or Tumbleweed, Arch and its relatives.

```sh
curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-linux-install.sh | sh
```

The script installs the `.deb` with apt or the `.rpm` with dnf or zypper (it
asks for your password), and the AppImage everywhere else. Add
`sh -s -- --appimage` to get the AppImage anyway, and `sh -s -- --uninstall` to
remove Kybern again (your data in `~/.kybern` stays). The script tells you up
front if your distribution is too old.

## Updates

Kybern checks for updates after launch and every few hours, and **Settings →
About** has a manual check. When one is ready, a card appears in the corner;
**Update and restart** installs it. On macOS, Windows and the Linux AppImage
that's all there is to it. With the `.deb` or `.rpm`, Kybern shows you the
`apt` or `dnf` command to run.

Updating restarts Kybern's daemon on that machine, which stops any turn in
progress. The conversation itself is kept, and the agent resumes it on your
next message.

## What you can do

- **Talk to several agents at once.** Each thread has its own agent, model and
  permission level. Switch a conversation to another agent or account without
  losing it.
- **See what an agent actually did.** Every turn folds into "Worked for 3m"
  with the commands, edits and diffs inside. You can undo a turn's file
  changes or rewind the conversation to an earlier point.
- **Let agents delegate.** Ask "have Codex implement this and Claude review it"
  and the helpers show up in the Agents panel as their own conversations. A
  project can also have a **Coordinator**, a long-running lead that plans
  work, hands it out and reviews what comes back.
- **Answer from anywhere.** Approvals, questions and requests for an API key
  show up as cards you can answer on your desktop or phone. Keys go straight
  into your project's git-ignored `.env`, never into the chat.
- **Keep the workspace in one window.** Terminals, a file explorer, a file
  editor, pull request reviews, notes and tasks sit next to the conversation.
  Agents can show you an interactive page or a preview of your dev server
  right in the thread.
- **Pick up old sessions.** Resume a conversation you started in an agent's own
  CLI, with its history.

The [guide](GUIDE.md) covers each of these in detail.

## On your phone

The companion app for Android and iPhone follows the same conversations:
streaming replies, approvals, files, diffs, terminals and tasks. The agents
still run on your computer, so keep it awake and reachable.

- **Android:** install the preview APK from the
  [EAS project page](https://expo.dev/accounts/treshnanda/projects/kybern-mobile/builds).
  It isn't on Google Play yet.
- **iPhone:** there's no App Store release yet; it needs a development build
  (see the [mobile README](apps/mobile/README.md)).

To pair, open **Pair a device** in the desktop app and scan the code with your
phone. If your phone isn't on the same network, turn on **Reachable over
Tailscale** first.

## Run agents on another machine

Agents can run on a server instead of your laptop. Each machine keeps its own
projects, threads and agent logins.

The simplest way is in the desktop app. Choose **Switch environment → Add
environment → Over SSH** and enter `user@host`. Kybern installs its daemon on
that machine, starts it and connects through an SSH tunnel it manages.

To set a server up yourself, this installs the daemon and the `kybern` command
without Rust, Node or a desktop. `--service` keeps it running as a systemd user
service:

```sh
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/Tresnanda/kybern/releases/latest/download/kybern-remote-install.sh | sh -s -- --service
```

The daemon on a server updates itself from **Settings → Agents → Updates**, or
with `kybern daemon-update`. Connecting over Tailscale or an SSH tunnel is
covered in the [guide](GUIDE.md#connect-to-another-machine-over-tailscale).

## Kybern Desktop (the older app)

Before 0.16.0, Kybern's desktop app was built with Tauri. It is retired: 0.18.0
was its last update. Install Kybern GPUIX (above) instead; it uses the same data
in `~/.kybern`, so your projects and chats carry over.

## Building from source

See [CONTRIBUTING.md](CONTRIBUTING.md). Releases are described in
[RELEASING.md](RELEASING.md).

## License

MIT.
