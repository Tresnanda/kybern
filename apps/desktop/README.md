# kybern desktop

The desktop client is a React app inside a Tauri 2 shell. It talks to the
machine-local `kybernd` over authenticated WebSocket RPC.

## Development

Install dependencies once, then use the package-level Tauri wrapper:

```sh
pnpm install --frozen-lockfile
KYBERN_DATA_DIR=/tmp/kyb KYBERN_NO_ACTIVATE=1 pnpm tauri dev
```

The wrapper builds `kybernd` with the matching Cargo profile and target,
stages the target-triple binary, and enables the sidecar configuration before
starting Tauri. The app reuses a compatible daemon for that data directory or
starts the staged daemon on an unused port.

Use `pnpm tauri ...`, `pnpm tauri:dev`, or `pnpm tauri:build`; calling
`pnpm exec tauri` directly bypasses sidecar preparation.

## Package

```sh
pnpm tauri build
```

The resulting desktop package contains both the Tauri executable and
`kybernd`. The daemon remains a separate process so the CLI and mobile clients
can keep using it after the desktop window closes.
