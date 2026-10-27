# Releasing

A push to `main` updates the source and runs CI; it does not publish a new
installed-app version. Relevant `main` changes also warm the desktop build
cache that release builds restore. Publishing is a separate action.

| Release unit | Version and delivery |
| --- | --- |
| Daemon, CLI, and desktop | Share the Rust workspace/Tauri version. `scripts/release.sh X.Y.Z` updates these versions and pushes `vX.Y.Z`. The release workflow builds `kybernd` and `kybern` once per target; the desktop bundles, which include the daemon and CLI, reuse those binaries, and the whole GitHub Release is published at once. The `gpuix` job of `desktop.yml` also builds Kybern GPUIX (`apps/gpuix`) for Apple Silicon and Intel Macs from the same dist binaries and attaches `kybern-gpuix_<version>_<aarch64|x86_64>.app.tar.gz` plus their signatures; `latest.json` carries them as `darwin-aarch64-gpuix` and `darwin-x86_64-gpuix`. The separate `gpuix-windows` job (beta) builds the Windows x64 installer `kybern-gpuix_<version>_x64-setup.exe` (`scripts/bundle-gpuix-windows.sh`) and its signature, published as `windows-x86_64-gpuix`; the manifest job runs whether that job succeeds or fails, so a Windows failure only leaves that entry out. The separate `gpuix-linux` job (beta) builds the Linux x86_64 packages on `ubuntu-22.04` from dist's static musl binaries: `kybern-gpuix_<version>_x86_64.AppImage` (signed; `latest.json` key `linux-x86_64-gpuix`), `.deb` and `.rpm`; like Windows, a Linux failure only leaves that entry out. |
| Android and iOS mobile app | Use `expo.version` in `apps/mobile/app.json`, independent of the desktop release number. EAS builds use the selected commit and profile. Android `versionCode` and iOS `buildNumber` identify individual binaries; EAS manages these remotely. Preview and production builds increment them automatically. |
| Wire protocol | `PROTOCOL_VERSION` is a compatibility contract, not an app release number. Bump it for breaking wire changes and update both clients and the daemon together. Additive features may still require a newer daemon even when the protocol number is unchanged. |

The tag-triggered release workflow requires successful main CI for the exact
tagged commit, including all nine jobs `scripts/check-release-ci.mjs` lists
(`requiredJobs`: rustfmt, clippy + test on Linux and macOS, desktop, gpuix, and
the four native WebKit shards). It waits for an in-progress run and blocks
publication on failures, skipped jobs, missing results, or timeout. Publication
also requires every platform bundle to succeed. Only the publishing `host` job
waits for that gate; the daemon archives and desktop bundles build while CI
finishes. Renaming or adding a job in `ci.yml` means updating `requiredJobs`
and its test in the same change.

Pull requests run only the CI jobs their files can affect (the `changes` job in
`ci.yml` lists the paths): a GPUIX-only change skips the Rust and WebKit jobs,
and a push to `main` always runs everything. A new push to a pull request cancels
its running checks; `main` runs are never cancelled. The `CI` job is red if any
job failed and green when the skipped ones were not needed, so it is the one
check a branch protection rule has to require.

Release builds restore caches that `main` saved and never save their own (a
cache saved under a tag cannot be restored by the next tag, and the repository's
cache storage is limited): `dist-cache.yml` builds the dist archives on a
`main` push that changes their dependencies, `gpuix-addon.yml` builds the
patched GPUIX native addon (both also run weekly, because GitHub deletes a
cache after seven days without use), and `desktop.yml` warms the Tauri build.

Before running `scripts/release.sh X.Y.Z`, add a matching `## X.Y.Z` entry near
the top of `CHANGELOG.md` with concise, user-visible bullets. Cargo-dist copies
that entry into the GitHub Release, and the desktop updater uses its first bullet
as the announcement summary by default. Add these optional comments inside the
entry when the announcement needs a separate headline or shorter summary:

```md
<!-- kybern-release-title: Short feature headline -->
<!-- kybern-release-summary: One concrete sentence about the release. -->
```

A daemon-only fix is shipped in the next daemon/desktop release. A desktop-only
fix uses that same release unit because desktop bundles its daemon. A mobile-only
fix uses a compatible EAS Update or a mobile build, with no desktop version bump. A change spanning the
clients and daemon may require both release paths; publish the daemon support
before shipping a mobile feature that depends on it.

The desktop release script does not change the mobile app version or start EAS.
Mobile builds and updates are manual. Mobile 0.1.1 enables EAS Update on the
`preview` and `production` channels with fingerprint-based runtime compatibility.
Compatible JavaScript updates download at launch and apply on the next launch;
Settings → App updates also allows an explicit check and restart. Older APKs
need one new install to enable this. Native changes always require a new binary.
See the [mobile update commands](apps/mobile/README.md#eas). Do not introduce mobile
version tags without first narrowing the daemon workflow's broad tag trigger.

`release.yml` is generated by `dist generate` from `dist-workspace.toml`, with
one hand edit that `allow-dirty = ["ci"]` permits: `custom-desktop` does not
list `custom-release-ci` in `needs` (see the comment in the file). To refresh the
file, remove `allow-dirty`, run `dist generate`, restore the setting, and make
that edit again; `scripts/check-release-ci.test.mjs` fails if it is missing, and
`scripts/check-release-workflow.mjs` (run by CI) fails if the file differs from
`dist generate` anywhere else. It
runs `desktop.yml` as a dist custom job once every target's daemon and CLI
archive exists; that workflow bundles those binaries into the desktop
installers, writes `latest.json`, and hands everything to dist's host job,
which creates the release. Use `dist plan` to check the distribution config and
`dist generate` to refresh the generated workflow after changing it. Run
`desktop.yml` by hand (`workflow_dispatch`) for a dry run that builds the
archives and bundles without publishing; its `binaries_from` input reuses an
existing release's archives instead.
